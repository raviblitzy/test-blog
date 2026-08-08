"""Collision-safe, deterministic derivation of the URL-safe slugs behind canonical URLs.

A slug is the readable path segment that identifies a post or a category in public URLs:
``GET /api/v1/posts/{slug}``, ``GET /api/v1/categories/{slug}`` and the client routes that
mirror them. It is part of the API contract rather than an internal detail, and it carries
one hard guarantee - it is written once, when the resource is created, and never changes
afterwards. Canonical link tags, the generated sitemap and every OpenGraph card are all
built from it, so recomputing a slug because a title was edited would silently invalidate
links that are already published and indexed. Nothing in this module recomputes one: there is
deliberately no "re-slug from the new title" helper, and adding one would break the
stability the SEO requirement rests on.

Two responsibilities, split so each can be tested on its own:

* :func:`slugify_title` turns a human title into a slug - lowercase ASCII, single hyphens,
  bounded length, never empty.
* :func:`unique_slug` resolves a collision against the slugs that already exist by
  appending an ascending numeric suffix.

Both bound their result by ``max_length`` unconditionally, suffix included: there is no input
for which either returns something longer. A bound too small to hold a suffixed slug is a
caller error and raises, rather than being honoured approximately - a slug that overshoots the
number the caller sized its column and its URLs against is not a usable slug.

Both are pure functions of their arguments. This module reads no environment variable,
opens no connection, and imports nothing from ``app.db``, ``app.models``,
``app.repositories``, ``app.services`` or ``app.api``: ``app.core`` is the bottom layer of
the backend and must stay that way. The collision *policy* lives here; the collision
*lookup* belongs to the caller. That split is what keeps this logic unit-testable against a
plain ``set`` and keeps the database out of it entirely.

``posts.slug`` and ``categories.slug`` are ``citext`` ``UNIQUE`` columns, so PostgreSQL
compares them case-insensitively: ``My-Post`` and ``my-post`` are the same value there, and
the second insert is rejected. The suffix is therefore chosen *before* the insert and
compared case-insensitively, so the happy path never has to recover from an
``IntegrityError``.

The intended call pattern, used by ``app.services.post_service`` when a post is created or
published without a slug, and by ``app.services.category_service`` when a category is
created or renamed:

.. code-block:: python

    base = slugify_title(payload.title)
    taken = await repository.slugs_starting_with(base)  # one indexed lookup
    slug = unique_slug(base, taken)

:func:`derive_unique_slug` composes exactly those two steps for a caller that already holds
the set of existing slugs.
"""

from collections.abc import Set as AbstractSet
from typing import Final

from slugify import slugify

__all__ = [
    "DEFAULT_MAX_LENGTH",
    "FALLBACK_SLUG",
    "derive_unique_slug",
    "slugify_title",
    "unique_slug",
]

DEFAULT_MAX_LENGTH: Final[int] = 80
"""Default upper bound on a derived slug, in characters.

Eighty leaves room for a collision suffix, a site origin and a path prefix inside the URL
length limits browsers and proxies impose, while still fitting a descriptive title. It is a
defaulted parameter rather than a setting on purpose: it is not one of the environment
variables the deployment contract declares, and it must not become one.
"""

FALLBACK_SLUG: Final[str] = "post"
"""Slug substituted for a title that carries no sluggable character.

An empty slug can neither be stored in a ``NOT NULL`` column nor address a URL, so a title
that is blank, whitespace only, pure punctuation or pure emoji resolves to this literal.
Being a fixed literal, it collides for two different unsluggable titles - intentionally, as
:func:`unique_slug` already resolves collisions, and ``post-2`` reads better in a URL than
a digest would.
"""

_SEPARATOR: Final[str] = "-"
"""The single word separator every slug in this system uses."""

_FIRST_COLLISION_SUFFIX: Final[int] = 2
"""First numeric suffix tried on collision.

Counting from two rather than one or zero is the convention a reader expects, because the
unsuffixed slug is conceptually already the first of its series.
"""


def _require_positive_max_length(max_length: int) -> None:
    """Reject a ``max_length`` that cannot describe a slug.

    Zero is not merely useless, it is actively wrong: ``python-slugify`` reads
    ``max_length=0`` as "no limit at all", so passing it through would drop the bound
    instead of honouring it. A negative value would slice from the end of the string. Both
    are caller mistakes, and both fail loudly here rather than reaching a URL.

    Args:
        max_length: The candidate limit.

    Raises:
        ValueError: If ``max_length`` is less than one.
    """
    if max_length < 1:
        msg = f"max_length must be a positive integer, got {max_length!r}"
        raise ValueError(msg)


def _truncate_on_boundary(slug: str, limit: int) -> str:
    """Shorten ``slug`` to at most ``limit`` characters without breaking its shape.

    The cut prefers a hyphen boundary, so a shortened slug still reads as whole words. When
    the prefix that fits holds no hyphen at all - a single long word - the cut is exact,
    because half a word in a URL is better than no URL. Either way the result carries no
    leading and no trailing hyphen.

    ``limit`` must be at least one. Every call site guarantees that, either through
    :func:`_require_positive_max_length` or through an explicit ``max(1, ...)`` floor.

    Args:
        slug: An already-slugified value. This helper shortens; it does not sanitise.
        limit: Maximum length of the result, at least one.

    Returns:
        A value of at most ``limit`` characters, non-empty whenever ``slug`` holds at least
        one character that is not the separator.
    """
    trimmed = slug.strip(_SEPARATOR)
    if len(trimmed) <= limit:
        return trimmed

    window = trimmed[:limit]
    boundary = window.rfind(_SEPARATOR)
    if boundary > 0:
        # Fall back to the last whole word that fits inside the window.
        window = window[:boundary]
    # For a well-formed slug this strip is a no-op, since a stripped value never opens with
    # the separator and a hard cut cannot end on one. It is kept because the invariant
    # "no trailing hyphen" must hold even for an input carrying repeated separators.
    return window.strip(_SEPARATOR)


def slugify_title(title: str, *, max_length: int = DEFAULT_MAX_LENGTH) -> str:
    """Derive a URL-safe slug from a human-readable title.

    Transliteration is delegated to ``python-slugify``, pinned for exactly this purpose: it
    folds accents and non-Latin scripts down to ASCII rather than discarding them, which a
    hand-rolled character filter would do. Truncation is delegated to the same call, with
    ``word_boundary=True`` so the cut lands between words, and ``save_order=True`` so the
    surviving words keep the order the author wrote them in - without it the library
    back-fills later short words and quietly reorders the title.

    The result always satisfies ``^[a-z0-9]+(?:-[a-z0-9]+)*$`` and is never longer than
    ``max_length``: lowercase ASCII alphanumerics separated by single hyphens, with no
    leading, trailing or repeated hyphen. That shape is part of the public API contract,
    because the value appears verbatim in ``/api/v1/posts/{slug}`` and in every canonical
    URL, sitemap entry and social card built from it.

    A title carrying no sluggable character - empty, whitespace only, pure punctuation or
    pure emoji - would otherwise slugify to the empty string, which is neither storable nor
    addressable; it resolves to :data:`FALLBACK_SLUG` instead. Nothing here consults the
    clock, a random source or a process-salted hash, so a given title yields the same slug
    on every call and in every process.

    Args:
        title: The title to derive from. Any Unicode is accepted.
        max_length: Maximum length of the returned slug. See :data:`DEFAULT_MAX_LENGTH`.

    Returns:
        A non-empty slug of at most ``max_length`` characters.

    Raises:
        ValueError: If ``max_length`` is not a positive integer.

    Examples:
        >>> slugify_title("Scaling FastAPI")
        'scaling-fastapi'
        >>> slugify_title("Hello, World!")
        'hello-world'
        >>> slugify_title("Ünïcodé Títlé")
        'unicode-title'
        >>> slugify_title("🎉🎉")
        'post'
    """
    _require_positive_max_length(max_length)

    slug = slugify(title, max_length=max_length, word_boundary=True, save_order=True)
    # Belt and braces: python-slugify already trims the separator, and this module's
    # contract forbids a leading or trailing hyphen unconditionally.
    slug = slug.strip(_SEPARATOR)
    if not slug:
        # Degenerate title. The fallback goes through the same helper so that even a
        # pathologically small max_length still yields a valid, non-empty slug.
        return _truncate_on_boundary(FALLBACK_SLUG, max_length)
    return slug


def unique_slug(
    base: str,
    taken: AbstractSet[str],
    *,
    max_length: int = DEFAULT_MAX_LENGTH,
) -> str:
    """Resolve ``base`` against slugs that already exist, suffixing it on collision.

    ``base`` is returned unchanged when it is free. Otherwise an ascending numeric suffix
    is appended - ``base-2``, ``base-3``, ``base-4`` - and the first candidate absent from
    ``taken`` is returned. The sequence is a plain ascending integer, so the search is
    deterministic and repeatable: the same ``base`` against the same ``taken`` always yields
    the same slug, with no clock and no randomness involved.

    Comparison is case-insensitive on both sides. ``posts.slug`` and ``categories.slug``
    are ``citext``, so a stored ``My-Post`` already occupies ``my-post``; folding only one
    side would hand back a slug the database then rejects with an ``IntegrityError``. The
    returned value keeps the casing of ``base`` itself - normalising shape is
    :func:`slugify_title`'s job, and its output is already lowercase.

    The length bound is honoured out of one budget rather than two, and it is honoured
    **unconditionally**. A suffix is spent from ``max_length`` instead of being added on top of
    it, so a ``base`` already sitting at the limit is shortened on a hyphen boundary to make
    room and the result still fits; a ``base`` longer than ``max_length`` - which cannot arrive
    from :func:`slugify_title` under the same limit - is shortened before anything else looks at
    it. No return value ever exceeds ``max_length``, for any input, which is what lets the
    caller size a column and a URL against that number and be right.

    Where a bound is too small to hold a suffixed slug at all, this function raises rather than
    quietly overshooting. A limit that cannot fit a one-character stem plus ``-2`` - that is,
    anything below three, or below four once the suffix reaches double digits - describes no
    valid slug, so returning one that breaks the stated bound would trade a loud, immediate,
    caller-side mistake for a silent one that surfaces later as an over-length path segment or a
    rejected insert. The condition is unreachable in this service: both slug columns are used at
    :data:`DEFAULT_MAX_LENGTH`, and the smallest bound any caller passes is far above three.

    This function performs no database access, by design. The caller asks its repository for
    the slugs already matching the base - one indexed lookup against the ``citext`` unique
    index - and passes them in as ``taken``. That keeps the collision policy here, the
    collision lookup in the repository layer, and this logic testable against a plain set.

    Args:
        base: The desired slug, normally the output of :func:`slugify_title`. A value that
            is empty or made only of separators resolves to :data:`FALLBACK_SLUG`, so the
            return value is never empty.
        taken: Slugs already in use. Any set-like collection works - ``set``,
            ``frozenset``, or a ``dict`` keys view straight off a query result.
        max_length: Maximum length of the returned slug, suffix included.

    Returns:
        A non-empty slug absent from ``taken`` under case-insensitive comparison, of at most
        ``max_length`` characters - always, with no exception.

    Raises:
        ValueError: If ``max_length`` is not a positive integer, or if a collision has to be
            suffixed and ``max_length`` cannot hold a one-character stem alongside the marker
            that would be needed.

    Examples:
        >>> unique_slug("scaling-fastapi", set())
        'scaling-fastapi'
        >>> unique_slug("scaling-fastapi", {"scaling-fastapi"})
        'scaling-fastapi-2'
        >>> unique_slug("scaling-fastapi", {"scaling-fastapi", "scaling-fastapi-2"})
        'scaling-fastapi-3'
        >>> unique_slug("my-post", {"My-Post"})
        'my-post-2'
    """
    _require_positive_max_length(max_length)

    # The caller may pass a value this module did not produce, and a separator-only base
    # can address no URL, so normalise before anything else looks at it.
    source = base.strip(_SEPARATOR) or FALLBACK_SLUG
    reserved = {entry.casefold() for entry in taken}

    candidate = _truncate_on_boundary(source, max_length)
    if candidate.casefold() not in reserved:
        return candidate

    # The search is bounded, not open-ended. Each candidate below is distinct, because the
    # digits following its final hyphen recover its suffix uniquely, so at most
    # len(reserved) of them can be taken and one of these len(reserved) + 1 candidates is
    # always free.
    last_suffix = _FIRST_COLLISION_SUFFIX + len(reserved)
    for suffix in range(_FIRST_COLLISION_SUFFIX, last_suffix + 1):
        marker = f"{_SEPARATOR}{suffix}"
        stem_budget = max_length - len(marker)
        if stem_budget < 1:
            # The bound cannot hold a stem beside this marker, so no candidate at this suffix
            # both fits and is a valid slug. Raising is the honest answer: the previous
            # behaviour kept the marker and overshot max_length, which turned a caller's
            # mistake into a value that violated the contract this function publishes - and
            # did so silently, to be discovered later as an over-length path segment or a
            # rejected insert. `max_length` and the marker are named so the caller can see
            # exactly what would not fit; the base is not quoted, since a caller passing a
            # two-character bound has a bug in the bound rather than in the title.
            msg = (
                f"max_length={max_length} is too small to suffix a collision: the marker "
                f"{marker!r} leaves no room for a stem. A suffixed slug needs at least "
                f"{len(marker) + 1} characters."
            )
            raise ValueError(msg)
        stem = _truncate_on_boundary(source, stem_budget)
        candidate = f"{stem}{marker}"
        if candidate.casefold() not in reserved:
            return candidate

    raise RuntimeError(  # pragma: no cover
        f"exhausted {last_suffix} slug candidates for {source!r}; the pigeonhole bound "
        "above makes this unreachable, so reaching it means the candidate sequence "
        "stopped being injective"
    )


def derive_unique_slug(
    title: str,
    taken: AbstractSet[str],
    *,
    max_length: int = DEFAULT_MAX_LENGTH,
) -> str:
    """Derive a slug from ``title`` and resolve it against ``taken`` in one call.

    A thin composition of :func:`slugify_title` and :func:`unique_slug` with no behaviour of
    its own, for the common case where the caller already holds the set of existing slugs.
    Both steps receive the same ``max_length``, so the suffix is accounted for inside the
    single bound rather than pushing the result past it.

    Args:
        title: The title to derive from.
        taken: Slugs already in use, compared case-insensitively.
        max_length: Maximum length of the returned slug, suffix included.

    Returns:
        A non-empty slug absent from ``taken``, never longer than ``max_length``.

    Raises:
        ValueError: If ``max_length`` is not a positive integer, or if a collision has to be
            suffixed and ``max_length`` cannot hold a stem alongside the marker - the same
            conditions :func:`unique_slug` documents, since this function only composes.

    Examples:
        >>> derive_unique_slug("Hello, World!", set())
        'hello-world'
        >>> derive_unique_slug("Hello, World!", {"hello-world"})
        'hello-world-2'
    """
    return unique_slug(slugify_title(title, max_length=max_length), taken, max_length=max_length)
