"""Unit tests for :mod:`app.core.slug` - the derivation behind every canonical URL.

Pure, database-free and synchronous throughout. Nothing here opens a connection, requests a
fixture, reaches for the suite's async construction helpers, or awaits anything: the module
under test consumes only ``python-slugify`` and a plain set, so its entire contract can be
exercised against literals. A test here that needed a database session or an in-process HTTP
transport would be mis-scoped, and would belong under ``tests/integration/`` instead.

Why it deserves this much scrutiny. AAP §0.1.4 orders slug generation *ahead* of both the post
lifecycle and the SEO plumbing, "because the canonical URL is written at creation time and must
not change afterwards". ``posts.slug`` and ``categories.slug`` are ``citext UNIQUE`` columns
whose values appear verbatim in ``GET /api/v1/posts/{slug}``, in every canonical link tag, in
the generated sitemap and in every social card. A regression in :func:`~app.core.slug.slugify_title`
or :func:`~app.core.slug.unique_slug` therefore does not surface as a failed request - it
silently invalidates links that are already published and indexed. These assertions are the
guard on that, which is why they pin *exact* values wherever the value is part of the contract.

Three properties are asserted throughout rather than in one place of their own:

1. **Shape.** :data:`SLUG_RE` is the single expression of the guarantee
   ``^[a-z0-9]+(?:-[a-z0-9]+)*$``. One match simultaneously proves lowercase-only,
   ASCII-only, hyphen-separated, no repeated hyphen and no leading or trailing hyphen, so
   every test that produces a slug checks it.
2. **Boundedness.** No call returns more than ``max_length`` characters, suffix included, and
   shortening never leaves a dangling hyphen behind.
3. **Determinism.** The same arguments yield the same slug on every call and in every process.
   ``taken`` is an unordered set, so a result that depended on iteration order would be
   reproducible on a developer's machine and wrong in production; the ordering tests exist to
   catch precisely that.

Values are asserted two ways on purpose. Concrete equality pins what the contract publishes,
while the property assertions - :data:`SLUG_RE`, ``isascii()`` and the length bound - hold
whatever transliteration table ``python-slugify`` ships. An upstream release that spells one
exotic character differently therefore cannot make this suite brittle, and the guarantees are
still proven rather than assumed.

The real module is imported and nothing in it is re-implemented here. ``slugify`` itself is
deliberately never called: asserting against the dependency would test the dependency instead
of the contract this project publishes on top of it.
"""

from __future__ import annotations

import re
from collections.abc import Set as AbstractSet
from typing import Final

import pytest

from app.core.slug import (
    DEFAULT_MAX_LENGTH,
    FALLBACK_SLUG,
    derive_unique_slug,
    slugify_title,
    unique_slug,
)

# ---------------------------------------------------------------------------------------
# The one expression of a well-formed slug
# ---------------------------------------------------------------------------------------

#: The shape every returned slug must have. Lowercase ASCII alphanumeric runs joined by single
#: hyphens, with nothing before the first run and nothing after the last. Matching it proves
#: five separate guarantees at once - lowercase-only, ASCII-only, hyphen-separated, no repeated
#: hyphen, no leading or trailing hyphen - which is why it is the assertion reused most often
#: below rather than a set of narrower checks that could each drift out of agreement.
SLUG_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _assert_well_formed(slug: str, *, max_length: int = DEFAULT_MAX_LENGTH) -> None:
    """Assert the four guarantees every value returned by the module carries.

    Collected into one helper because they apply to every return value of all three public
    functions, and a battery that restated them inline would drift. Defined in this module so
    pytest's assertion rewriting still reports which of the four failed and with what value.

    Args:
        slug: The value under test.
        max_length: The bound the producing call was given.
    """
    assert slug != ""
    assert SLUG_RE.fullmatch(slug) is not None
    assert slug.isascii()
    assert len(slug) <= max_length


# ---------------------------------------------------------------------------------------
# Titles. Grouped by the property each group exercises, and every expected value below was
# produced by the pinned python-slugify 8.0.4 rather than predicted.
# ---------------------------------------------------------------------------------------

#: Titles paired with the exact slug the contract publishes for them. Deliberately broad: case
#: folding, accent transliteration, punctuation and whitespace collapsing, ampersands, em
#: dashes, underscores, digits, an already-clean value and hyphen bookends.
_DERIVATIONS: Final[tuple[tuple[str, str], ...]] = (
    ("Hello World", "hello-world"),
    ("Scaling FastAPI", "scaling-fastapi"),
    ("Café Déjà Vu", "cafe-deja-vu"),
    ("Ünïcodé Títlé", "unicode-title"),
    ("naïve façade — coöperate", "naive-facade-cooperate"),
    ("Hello,   World!!!  --  Again", "hello-world-again"),
    ("Tabs\tand\nnewlines\r\nhere", "tabs-and-newlines-here"),
    ("Cats & Dogs", "cats-dogs"),
    ("Rock — Paper — Scissors", "rock-paper-scissors"),
    ("snake_case and kebab-case_MIXED", "snake-case-and-kebab-case-mixed"),
    ("already-clean-slug", "already-clean-slug"),
    ("Top 10 Python 3.14 Features", "top-10-python-3-14-features"),
    ("  Leading and trailing   ", "leading-and-trailing"),
    ("---Hyphen Bookends---", "hyphen-bookends"),
)

#: Titles written in a script other than Latin, or in Latin with diacritics. Asserted for
#: ASCII-ness rather than for a literal, so an upstream transliteration table that spells one of
#: them differently cannot break the suite while the ASCII guarantee is still proven.
_NON_ASCII_TITLES: Final[tuple[str, ...]] = (
    "Café Déjà Vu",
    "Ünïcodé Títlé",
    "naïve façade — coöperate",
    "Ход конём",
    "日本語のタイトル",
    "Ελληνικά γράμματα",
)

#: Titles carrying no sluggable character at all. Empty, whitespace only, pure punctuation,
#: pure separators, pure underscores and pure emoji: each would slugify to the empty string,
#: which can be neither stored in a NOT NULL column nor addressed as a URL.
_DEGENERATE_TITLES: Final[tuple[str, ...]] = (
    "",
    "   ",
    "\t\n",
    "!!!",
    "...",
    "-",
    "---",
    "???",
    "@#$%^&*()",
    "___",
    "🎉🎉🎉",
)

#: A nine-word title. Short enough to read, long enough that a bound anywhere between 1 and 42
#: has to shorten it, which makes it the vehicle for every truncation assertion.
_WORDY_TITLE: Final[str] = "the quick brown fox jumps over the lazy dog"

#: A 107-character title, so the default bound of 80 is exceeded and truncation is unavoidable
#: without an explicit ``max_length`` being passed.
_LONG_TITLE: Final[str] = (
    "A Deeply Considered and Exhaustively Detailed Exploration of "
    "Asynchronous Python Web Services in Production"
)

#: A single 45-character word with no internal boundary to cut on, which is the one case where
#: shortening cannot land between words and has to cut exactly.
_UNBROKEN_WORD: Final[str] = "Pneumonoultramicroscopicsilicovolcanoconiosis"

#: Valid bounds spanning the useful range, from one that forces aggressive shortening of every
#: title in the batteries above to the default. Every one of them is honoured unconditionally.
_BOUNDS: Final[tuple[int, ...]] = (10, 20, 40, 80)

#: The shortening ladder for :data:`_WORDY_TITLE`, in the regime where a hyphen boundary exists
#: inside the window that fits. Each expected value is a run of whole words from the title, so a
#: cut that landed mid-word or on a separator would fail on equality as well as on shape.
_WORD_BOUNDARY_LADDER: Final[tuple[tuple[int, str], ...]] = (
    (9, "the-quick"),
    (10, "the-quick"),
    (15, "the-quick-brown"),
    (20, "the-quick-brown-fox"),
    (30, "the-quick-brown-fox-jumps-over"),
    (43, "the-quick-brown-fox-jumps-over-the-lazy-dog"),
    (80, "the-quick-brown-fox-jumps-over-the-lazy-dog"),
)

#: Values that describe no slug at all. Zero is not merely useless: ``python-slugify`` reads
#: ``max_length=0`` as "no limit", so accepting it would drop the bound instead of honouring it.
_INVALID_BOUNDS: Final[tuple[int, ...]] = (0, -1, -80)

#: Message fragment the module raises for a bound below one, matched rather than the whole
#: string so the offending value can be interpolated into it without breaking the assertion.
_NON_POSITIVE_BOUND_MESSAGE: Final[str] = "max_length must be a positive integer"

#: Message fragment raised when a collision has to be suffixed and the bound cannot hold even a
#: one-character stem beside the marker.
_UNSUFFIXABLE_BOUND_MESSAGE: Final[str] = "too small to suffix a collision"

#: Every title in :data:`_DERIVATIONS` plus the over-long one, for the bound matrix.
_ALL_TITLES: Final[tuple[str, ...]] = (*(title for title, _ in _DERIVATIONS), _LONG_TITLE)

#: A cross-section for the idempotence assertion - accented, punctuation-heavy, numeric, already
#: clean, non-Latin, emoji-only and empty - so the property is proven across every code path
#: derivation can take rather than only the one that needs no transformation.
_IDEMPOTENT_TITLES: Final[tuple[str, ...]] = (
    "Café Déjà Vu",
    "Hello,   World!!!  --  Again",
    "Top 10 Python 3.14 Features",
    "already-clean-slug",
    "Ход конём",
    "🎉🎉🎉",
    "",
)

# ---------------------------------------------------------------------------------------
# Collision tables. Every `taken` payload is a TUPLE so the table itself cannot be mutated by a
# test; each test builds a plain `set` from it, which is the type callers actually pass. The one
# exception is the test that proves any set-like collection is accepted.
# ---------------------------------------------------------------------------------------

#: The ascending suffix sequence, stated exhaustively rather than sampled. The first row is the
#: free case; each subsequent row adds the slug the previous row produced. Asserting the exact
#: sequence - and not merely "something other than the base" - is what pins determinism: the
#: suffix has to be reproducible across processes and environments, because a post published in
#: one environment and re-derived in another must land on the same canonical URL.
_COLLISION_LADDER: Final[tuple[tuple[tuple[str, ...], str], ...]] = (
    ((), "hello"),
    (("hello",), "hello-2"),
    (("hello", "hello-2"), "hello-3"),
    (("hello", "hello-2", "hello-3"), "hello-4"),
    (("hello", "hello-2", "hello-3", "hello-4"), "hello-5"),
)

#: Taken sets with holes in them. The lowest free suffix wins, so a deleted post does not push
#: later slugs upward forever, and the counter walks rather than jumping past the gap.
_GAPPED_LADDER: Final[tuple[tuple[tuple[str, ...], str], ...]] = (
    (("hello", "hello-3"), "hello-2"),
    (("hello", "hello-2", "hello-4"), "hello-3"),
    (("hello", "hello-2", "hello-3", "hello-5"), "hello-4"),
)

#: Taken sets that do not reserve ``hello-world`` under case-insensitive comparison, so the base
#: is returned untouched. The last row is the one worth having: a reserved *suffixed* form must
#: not make the unsuffixed base look occupied.
_FREE_BASE_TAKEN: Final[tuple[tuple[str, ...], ...]] = (
    (),
    ("other",),
    ("hello",),
    ("hello-world-2", "hello-world-3"),
    ("HELLO-WORLDS", "hello-worldly"),
)

#: ``posts.slug`` and ``categories.slug`` are ``citext``, so PostgreSQL already considers
#: ``My-Post`` and ``my-post`` the same value. Folding only one side of the comparison would hand
#: back a slug the database then rejects with an ``IntegrityError``, so the suffix has to be
#: chosen against a case-insensitive view of what is taken.
_CASE_INSENSITIVE_LADDER: Final[tuple[tuple[tuple[str, ...], str], ...]] = (
    (("My-Post",), "my-post-2"),
    (("MY-POST", "My-Post-2"), "my-post-3"),
    (("my-post", "MY-POST-2", "My-Post-3"), "my-post-4"),
)

#: Bases that carry no sluggable character of their own, or only separators. A caller may pass a
#: value this module did not produce, and neither an empty string nor a bare hyphen addresses a
#: URL, so the base is normalised before the collision search looks at it.
_NORMALISED_BASES: Final[tuple[tuple[str, tuple[str, ...], str], ...]] = (
    ("", (), "post"),
    ("-", (), "post"),
    ("---", (), "post"),
    ("-hello-", (), "hello"),
    ("---", ("post",), "post-2"),
    ("", ("post", "post-2"), "post-3"),
)

#: Bounds spent out of one budget rather than two. In every row the marker is paid for by
#: shortening the stem, so the result still fits - which is what lets a caller size a column and
#: a URL against ``max_length`` and be right. Rows two and four are the interesting ones: the
#: stem loses a whole word in row two because a hyphen boundary exists inside the budget, and is
#: cut exactly in row one because none does.
_BOUNDED_SUFFIX_CASES: Final[tuple[tuple[str, tuple[str, ...], int, str], ...]] = (
    ("abcdefghij", ("abcdefghij",), 10, "abcdefgh-2"),
    ("hello-world-again", ("hello-world",), 13, "hello-2"),
    ("hello-world-again", (), 13, "hello-world"),
    ("a", ("a",), 3, "a-2"),
    ("ab", ("ab", "a-2"), 3, "a-3"),
)

#: The same four reserved slugs presented in four different orders. A ``set`` iterates in an
#: order derived from its members' hashes, so an implementation that searched by iterating
#: ``taken`` instead of counting upward would answer differently depending on insertion order -
#: reproducibly on one machine and wrongly on another. All four must yield ``hello-4``.
_TAKEN_ORDERINGS: Final[tuple[tuple[str, ...], ...]] = (
    ("hello", "hello-2", "hello-3", "Hello-5"),
    ("Hello-5", "hello-3", "hello-2", "hello"),
    ("hello-3", "hello", "Hello-5", "hello-2"),
    ("hello-2", "Hello-5", "hello", "hello-3"),
)

#: Title, reserved slugs and the composed result, covering the free case, the first and second
#: collision, an accented title and a degenerate one - so the composition is pinned across every
#: branch its two steps can take between them.
_COMPOSED_CASES: Final[tuple[tuple[str, tuple[str, ...], str], ...]] = (
    ("Hello, World!", (), "hello-world"),
    ("Hello, World!", ("hello-world",), "hello-world-2"),
    ("Hello, World!", ("hello-world", "hello-world-2"), "hello-world-3"),
    ("Café Déjà Vu", ("cafe-deja-vu",), "cafe-deja-vu-2"),
    ("Top 10 Python 3.14 Features", (), "top-10-python-3-14-features"),
    ("   ", ("post",), "post-2"),
    ("!!!", ("post", "post-2"), "post-3"),
)

#: Titles for the equivalence matrix. A curated cross-section rather than every title in the
#: file, because the matrix multiplies by reserved set and by bound: one short title, one
#: accented, one that shortens at every bound, one that exceeds the default, one already clean
#: and one degenerate covers every branch the two composed steps can take between them.
_COMPOSED_MATRIX_TITLES: Final[tuple[str, ...]] = (
    "Hello, World!",
    "Café Déjà Vu",
    _WORDY_TITLE,
    _LONG_TITLE,
    "already-clean-slug",
    "!!!",
)

#: Reserved sets for the equivalence matrix. Chosen so that some rows collide with the derived
#: slug at some bounds and not at others, which exercises both the free and the suffixed path
#: within the same matrix rather than needing two.
_COMPOSED_TAKEN: Final[tuple[tuple[str, ...], ...]] = (
    (),
    ("hello-world",),
    ("post", "post-2"),
    ("the-quick-brown-fox", "the-quick-brown", "the-quick"),
    ("cafe-deja-vu", "cafe-deja-vu-2"),
)


class TestSlugifyTitle:
    """Derivation of a slug from a human-readable title."""

    @pytest.mark.parametrize(("title", "expected"), _DERIVATIONS)
    def test_derives_the_published_slug(self, title: str, expected: str) -> None:
        """A title yields exactly the slug the contract publishes for it.

        Equality rather than a property, because these values reach the URL. Lowercasing,
        hyphen separation, accent transliteration, punctuation and whitespace collapsing,
        ampersand and em-dash removal, underscore conversion, digit survival and the
        already-clean case are all covered by the one table.
        """
        result = slugify_title(title)

        assert result == expected
        _assert_well_formed(result)

    @pytest.mark.parametrize("title", _NON_ASCII_TITLES)
    def test_transliterates_non_ascii_input_rather_than_discarding_it(self, title: str) -> None:
        """Accented and non-Latin titles fold down to ASCII with content left over.

        Asserted as a property, so a future ``python-slugify`` release that spells one exotic
        character differently cannot fail this test while the ASCII guarantee still holds. The
        unambiguous cases are pinned by literal in :data:`_DERIVATIONS` instead.
        """
        result = slugify_title(title)

        assert result.isascii()
        assert result != FALLBACK_SLUG
        _assert_well_formed(result)

    def test_collapses_runs_of_punctuation_and_whitespace(self) -> None:
        """Repeated separators, tabs and newlines never survive as repeated hyphens."""
        result = slugify_title("Hello,   World!!!  --  Again")

        assert result == "hello-world-again"
        assert "--" not in result
        assert not result.startswith("-")
        assert not result.endswith("-")
        _assert_well_formed(result)

    def test_already_clean_input_is_returned_unchanged(self) -> None:
        """A value that is already a slug survives derivation untouched.

        The property that makes re-deriving safe: a service that slugified a stored slug would
        otherwise mutate a canonical URL that is already indexed.
        """
        for clean in ("already-clean-slug", "hello-world", "post", "top-10-python-3-14"):
            assert slugify_title(clean) == clean

    @pytest.mark.parametrize("title", _IDEMPOTENT_TITLES)
    def test_is_idempotent(self, title: str) -> None:
        """Slugifying a slug is a no-op, degenerate and non-Latin inputs included."""
        once = slugify_title(title)

        assert slugify_title(once) == once
        _assert_well_formed(once)

    def test_digits_survive_derivation(self) -> None:
        """Numbers in a title reach the slug, with dotted versions split on the separator."""
        result = slugify_title("Top 10 Python 3.14 Features")

        assert result == "top-10-python-3-14-features"
        assert "10" in result
        assert "3-14" in result
        _assert_well_formed(result)

    @pytest.mark.parametrize("max_length", _BOUNDS)
    @pytest.mark.parametrize("title", _ALL_TITLES)
    def test_honours_every_explicit_bound(self, title: str, max_length: int) -> None:
        """No title and no bound in the matrix produces an over-length or malformed slug."""
        result = slugify_title(title, max_length=max_length)

        _assert_well_formed(result, max_length=max_length)

    def test_the_default_bound_is_the_documented_constant(self) -> None:
        """Omitting ``max_length`` applies exactly :data:`~app.core.slug.DEFAULT_MAX_LENGTH`.

        Proven by agreement rather than by asserting a length, so the test states the contract
        - "the default is that constant" - instead of restating an arithmetic result.
        """
        assert DEFAULT_MAX_LENGTH == 80
        assert len(_LONG_TITLE) > DEFAULT_MAX_LENGTH

        result = slugify_title(_LONG_TITLE)

        assert result == slugify_title(_LONG_TITLE, max_length=DEFAULT_MAX_LENGTH)
        _assert_well_formed(result)

    def test_truncation_lands_on_a_word_boundary(self) -> None:
        """A bound that falls mid-word cuts back to the last whole word, hyphen included.

        Naive character truncation of ``the-quick-brown-fox-...`` at fifteen would keep
        ``the-quick-brown`` and at sixteen would keep ``the-quick-brown-``, leaving a dangling
        separator in the URL. Every segment of the result is checked against the words of the
        untruncated slug, so a fragment such as ``bro`` would fail rather than merely look odd.
        """
        full = slugify_title(_WORDY_TITLE)
        words = set(full.split("-"))

        result = slugify_title(_WORDY_TITLE, max_length=15)

        assert result == "the-quick-brown"
        assert len(result) <= 15
        assert not result.endswith("-")
        assert not result.startswith("-")
        assert SLUG_RE.fullmatch(result) is not None
        assert set(result.split("-")) <= words

    @pytest.mark.parametrize(("max_length", "expected"), _WORD_BOUNDARY_LADDER)
    def test_every_shortened_segment_is_a_whole_word(self, max_length: int, expected: str) -> None:
        """Across the whole ladder the cut lands between words, never inside one."""
        words = set(slugify_title(_WORDY_TITLE).split("-"))

        result = slugify_title(_WORDY_TITLE, max_length=max_length)

        assert result == expected
        assert set(result.split("-")) <= words
        _assert_well_formed(result, max_length=max_length)

    @pytest.mark.parametrize("max_length", [1, 2, 3, 4, 5])
    def test_a_bound_below_the_first_word_still_yields_a_usable_slug(self, max_length: int) -> None:
        """Below the width of the first word the cut is exact, and still well formed.

        Half a word in a URL beats no URL, so the guarantee that survives here is shape and
        boundedness rather than word completeness. ``max_length=4`` is the interesting case: the
        window ``the-`` ends on a separator, and the separator must not reach the result.
        """
        result = slugify_title(_WORDY_TITLE, max_length=max_length)

        assert not result.endswith("-")
        _assert_well_formed(result, max_length=max_length)

    @pytest.mark.parametrize(
        ("max_length", "expected"), [(10, "pneumonoul"), (20, "pneumonoultramicrosc")]
    )
    def test_an_unbroken_word_is_cut_exactly(self, max_length: int, expected: str) -> None:
        """With no boundary anywhere in the window the cut uses the full bound."""
        result = slugify_title(_UNBROKEN_WORD, max_length=max_length)

        assert result == expected
        assert len(result) == max_length
        _assert_well_formed(result, max_length=max_length)

    @pytest.mark.parametrize("title", _DEGENERATE_TITLES)
    def test_a_title_with_nothing_sluggable_falls_back(self, title: str) -> None:
        """Empty, blank, punctuation-only, separator-only and emoji-only titles all resolve.

        An empty slug can be stored in no ``NOT NULL`` column and can address no URL, so the
        fallback is what keeps the create path viable for a title the author gave no words to.
        """
        result = slugify_title(title)

        assert result == FALLBACK_SLUG
        _assert_well_formed(result)

    def test_the_fallback_is_the_documented_literal(self) -> None:
        """The substituted value is a fixed, readable literal rather than a digest.

        Pinned deliberately. Two unsluggable titles collide on it, which is intended:
        :func:`~app.core.slug.unique_slug` already resolves collisions, and ``post-2`` reads
        better in a URL than a hash would. A change here changes published URLs.
        """
        assert FALLBACK_SLUG == "post"
        _assert_well_formed(FALLBACK_SLUG)

    @pytest.mark.parametrize("title", _DEGENERATE_TITLES)
    def test_the_fallback_is_stable_across_calls(self, title: str) -> None:
        """The same degenerate title yields the same slug every time it is derived.

        Stability matters more here than anywhere else: nothing in the input distinguishes one
        unsluggable title from another, so a clock-, counter- or salt-derived fallback would
        hand two callers different canonical URLs for the same request.
        """
        assert slugify_title(title) == slugify_title(title)

    @pytest.mark.parametrize(
        ("max_length", "expected"),
        [(1, "p"), (2, "po"), (3, "pos"), (4, "post"), (5, "post"), (80, "post")],
    )
    def test_the_fallback_is_shortened_rather_than_dropped(
        self, max_length: int, expected: str
    ) -> None:
        """A bound narrower than the fallback shortens it instead of returning nothing."""
        result = slugify_title("!!!", max_length=max_length)

        assert result == expected
        _assert_well_formed(result, max_length=max_length)

    @pytest.mark.parametrize("max_length", _INVALID_BOUNDS)
    def test_rejects_a_non_positive_bound(self, max_length: int) -> None:
        """Zero and negative bounds fail loudly instead of being honoured approximately."""
        with pytest.raises(ValueError, match=_NON_POSITIVE_BOUND_MESSAGE):
            slugify_title("Hello World", max_length=max_length)

    def test_the_bound_cannot_be_passed_positionally(self) -> None:
        """``max_length`` is keyword-only, so a second positional argument is a TypeError.

        Documents the signature rather than a behaviour: a caller who passed the bound
        positionally would otherwise be silently supplying it as the title.
        """
        with pytest.raises(TypeError, match="positional"):
            slugify_title("Hello World", 10)  # type: ignore[misc]


class TestUniqueSlug:
    """Resolution of a base slug against the slugs that already exist."""

    @pytest.mark.parametrize("taken", _FREE_BASE_TAKEN)
    def test_returns_the_base_when_it_is_free(self, taken: tuple[str, ...]) -> None:
        """A base nothing has reserved comes back untouched, suffix-free.

        The common case by far, and the one that must not regress: appending ``-2`` to a slug
        that was never taken would make every first post carry a suffix in its URL.
        """
        reserved = set(taken)

        result = unique_slug("hello-world", reserved)

        assert result == "hello-world"
        assert result not in reserved
        _assert_well_formed(result)

    def test_the_first_collision_appends_two(self) -> None:
        """The suffix series opens at two, because the unsuffixed slug is its own first member."""
        assert unique_slug("hello", {"hello"}) == "hello-2"

    def test_the_second_collision_appends_three(self) -> None:
        """The series then increments by one rather than restarting or skipping."""
        assert unique_slug("hello", {"hello", "hello-2"}) == "hello-3"

    @pytest.mark.parametrize(("taken", "expected"), _COLLISION_LADDER)
    def test_walks_the_counter_upward(self, taken: tuple[str, ...], expected: str) -> None:
        """The whole ascending sequence is exact, not merely different from the base."""
        reserved = set(taken)

        result = unique_slug("hello", reserved)

        assert result == expected
        assert result not in reserved
        _assert_well_formed(result)

    @pytest.mark.parametrize(("taken", "expected"), _GAPPED_LADDER)
    def test_a_gap_yields_the_lowest_free_suffix(
        self, taken: tuple[str, ...], expected: str
    ) -> None:
        """A hole in the taken set is filled rather than stepped over."""
        reserved = set(taken)

        result = unique_slug("hello", reserved)

        assert result == expected
        assert result not in reserved
        _assert_well_formed(result)

    @pytest.mark.parametrize(("taken", "expected"), _CASE_INSENSITIVE_LADDER)
    def test_comparison_folds_case_on_both_sides(
        self, taken: tuple[str, ...], expected: str
    ) -> None:
        """A slug reserved in different casing still counts as taken.

        Without this the happy path would have to recover from an ``IntegrityError``: the target
        columns are ``citext``, so PostgreSQL rejects the second insert of a case variant.
        """
        reserved = set(taken)
        folded = {entry.casefold() for entry in reserved}

        result = unique_slug("my-post", reserved)

        assert result == expected
        assert result.casefold() not in folded
        _assert_well_formed(result)

    @pytest.mark.parametrize(("base", "taken", "expected"), _NORMALISED_BASES)
    def test_normalises_a_base_that_carries_no_slug(
        self, base: str, taken: tuple[str, ...], expected: str
    ) -> None:
        """An empty or separator-only base resolves to the fallback rather than to nothing."""
        reserved = set(taken)

        result = unique_slug(base, reserved)

        assert result == expected
        assert result not in reserved
        _assert_well_formed(result)

    @pytest.mark.parametrize(
        "taken",
        [
            {"hello", "hello-2"},
            frozenset({"hello", "hello-2"}),
            dict.fromkeys(("hello", "hello-2")).keys(),
        ],
    )
    def test_accepts_any_set_like_collection(self, taken: AbstractSet[str]) -> None:
        """A ``set``, a ``frozenset`` and a keys view all work.

        The documented call pattern hands the function a collection straight off a repository
        query, so it is typed to the abstract protocol rather than to ``set``. A caller should
        not have to copy a keys view into a set to satisfy a signature.
        """
        result = unique_slug("hello", taken)

        assert result == "hello-3"
        assert result not in taken
        _assert_well_formed(result)

    @pytest.mark.parametrize("ordering", _TAKEN_ORDERINGS)
    def test_is_independent_of_iteration_order(self, ordering: tuple[str, ...]) -> None:
        """Four insertion orders of the same reserved slugs all resolve identically."""
        result = unique_slug("hello", set(ordering))

        assert result == "hello-4"
        _assert_well_formed(result)

    def test_repeated_calls_return_the_same_slug(self) -> None:
        """Determinism stated directly: no clock, no randomness, no process-local salt."""
        taken = {"hello", "hello-2"}

        assert unique_slug("hello", taken) == unique_slug("hello", taken)
        assert unique_slug("hello", set(taken)) == "hello-3"

    def test_reaches_a_double_digit_suffix(self) -> None:
        """The search does not stop at nine, and a two-character marker is still well formed."""
        taken = {"hello", *(f"hello-{suffix}" for suffix in range(2, 12))}

        result = unique_slug("hello", taken)

        assert result == "hello-12"
        assert result not in taken
        _assert_well_formed(result)

    @pytest.mark.parametrize(("base", "taken", "max_length", "expected"), _BOUNDED_SUFFIX_CASES)
    def test_never_exceeds_the_bound_when_suffixing(
        self, base: str, taken: tuple[str, ...], max_length: int, expected: str
    ) -> None:
        """The marker is spent from ``max_length`` rather than added on top of it.

        Also the one place a trailing hyphen could plausibly appear - shortening a stem to make
        room can land the cut on a separator - so shape is asserted alongside the bound.
        """
        reserved = set(taken)

        result = unique_slug(base, reserved, max_length=max_length)

        assert result == expected
        assert result not in reserved
        assert not result.endswith("-")
        _assert_well_formed(result, max_length=max_length)

    def test_a_base_already_at_the_default_limit_is_shortened_to_fit(self) -> None:
        """A base that fills the whole budget still gets a suffix, by giving ground for it."""
        base = slugify_title(_LONG_TITLE)
        assert len(base) == DEFAULT_MAX_LENGTH

        result = unique_slug(base, {base})

        assert result.endswith("-2")
        assert result != base
        assert result not in {base}
        _assert_well_formed(result)

    def test_a_double_digit_marker_is_also_paid_for_out_of_the_bound(self) -> None:
        """Widening the marker from two characters to three shortens the stem further."""
        base = "abcdefgh"
        taken = {
            base,
            *(f"{base}-{suffix}" for suffix in range(2, 12)),
            *(f"abcdef-{suffix}" for suffix in range(2, 12)),
        }

        result = unique_slug(base, taken, max_length=10)

        assert result == "abcdefg-10"
        assert result not in taken
        _assert_well_formed(result, max_length=10)

    @pytest.mark.parametrize("max_length", [1, 2])
    def test_rejects_a_bound_too_small_to_hold_a_suffix(self, max_length: int) -> None:
        """A bound that can describe no suffixed slug raises instead of overshooting.

        Raising is the honest answer. Keeping the marker and returning three characters under a
        bound of two would trade a loud, immediate caller-side mistake for a silent one, to be
        discovered later as an over-length path segment or a rejected insert.
        """
        with pytest.raises(ValueError, match=_UNSUFFIXABLE_BOUND_MESSAGE):
            unique_slug("a", {"a"}, max_length=max_length)

    @pytest.mark.parametrize("max_length", _INVALID_BOUNDS)
    def test_rejects_a_non_positive_bound(self, max_length: int) -> None:
        """Zero and negative bounds are refused here exactly as they are during derivation."""
        with pytest.raises(ValueError, match=_NON_POSITIVE_BOUND_MESSAGE):
            unique_slug("hello", {"hello"}, max_length=max_length)

    def test_does_not_mutate_the_taken_set(self) -> None:
        """The caller's set comes back exactly as it went in.

        Callers build ``taken`` from one indexed prefix query and reuse it - the seeder resolves
        several slugs against a single lookup - so recording the chosen slug into the caller's
        set would be a real defect rather than a theoretical one.
        """
        taken = {"hello", "hello-2"}
        snapshot = set(taken)

        result = unique_slug("hello", taken)

        assert result == "hello-3"
        assert taken == snapshot
        assert len(taken) == 2

    def test_the_bound_cannot_be_passed_positionally(self) -> None:
        """``max_length`` is keyword-only here too, so the signature cannot drift apart."""
        with pytest.raises(TypeError, match="positional"):
            unique_slug("hello", set(), 10)  # type: ignore[misc]


class TestDeriveUniqueSlug:
    """The two-step composition callers use when they already hold the existing slugs."""

    @pytest.mark.parametrize(("title", "taken", "expected"), _COMPOSED_CASES)
    def test_composes_derivation_and_collision_resolution(
        self, title: str, taken: tuple[str, ...], expected: str
    ) -> None:
        """One call performs both steps and returns what the pair would have returned."""
        reserved = set(taken)

        result = derive_unique_slug(title, reserved)

        assert result == expected
        assert result not in reserved
        _assert_well_formed(result)

    @pytest.mark.parametrize("max_length", _BOUNDS)
    @pytest.mark.parametrize("taken", _COMPOSED_TAKEN)
    @pytest.mark.parametrize("title", _COMPOSED_MATRIX_TITLES)
    def test_is_exactly_the_two_step_form(
        self, title: str, taken: tuple[str, ...], max_length: int
    ) -> None:
        """Equivalence asserted across the whole matrix, so the helper cannot drift.

        This is the behavioural statement of "a thin composition with no behaviour of its own",
        and it is also what proves both steps receive the *same* bound: passing ``max_length``
        to only one of them would make the composed result differ from the explicit pair for
        every title long enough to be shortened.
        """
        reserved = set(taken)

        composed = derive_unique_slug(title, reserved, max_length=max_length)
        stepwise = unique_slug(
            slugify_title(title, max_length=max_length), reserved, max_length=max_length
        )

        assert composed == stepwise
        _assert_well_formed(composed, max_length=max_length)

    def test_spends_the_suffix_from_one_shared_budget(self) -> None:
        """A title that fills the bound is shortened to make room, not pushed past it.

        Accounting the suffix inside the single bound is the whole reason the composition exists:
        deriving at eighty and then suffixing to eighty-two would produce a slug two characters
        longer than the column and the URL were sized for.
        """
        crowded = slugify_title(_LONG_TITLE)

        result = derive_unique_slug(_LONG_TITLE, {crowded}, max_length=DEFAULT_MAX_LENGTH)

        assert result.endswith("-2")
        assert result != crowded
        _assert_well_formed(result)

    def test_propagates_an_explicit_bound_to_both_steps(self) -> None:
        """A narrow bound shortens the derived stem before the marker is appended."""
        occupied = slugify_title(_WORDY_TITLE, max_length=20)
        assert occupied == "the-quick-brown-fox"

        result = derive_unique_slug(_WORDY_TITLE, {occupied}, max_length=20)

        assert result == "the-quick-brown-2"
        assert result != occupied
        _assert_well_formed(result, max_length=20)

    def test_a_degenerate_title_resolves_through_the_fallback(self) -> None:
        """An unsluggable title still yields an addressable, unused slug."""
        result = derive_unique_slug("🎉🎉🎉", {FALLBACK_SLUG, f"{FALLBACK_SLUG}-2"})

        assert result == "post-3"
        _assert_well_formed(result)

    @pytest.mark.parametrize("max_length", _INVALID_BOUNDS)
    def test_rejects_a_non_positive_bound(self, max_length: int) -> None:
        """The composition refuses what both of its steps refuse, rather than masking it."""
        with pytest.raises(ValueError, match=_NON_POSITIVE_BOUND_MESSAGE):
            derive_unique_slug("Hello World", set(), max_length=max_length)

    def test_rejects_a_bound_too_small_to_hold_a_suffix(self) -> None:
        """A collision under an unsuffixable bound raises through the composition too."""
        with pytest.raises(ValueError, match=_UNSUFFIXABLE_BOUND_MESSAGE):
            derive_unique_slug("A", {"a"}, max_length=2)

    def test_the_bound_cannot_be_passed_positionally(self) -> None:
        """Keyword-only across all three public functions, with no exception."""
        with pytest.raises(TypeError, match="positional"):
            derive_unique_slug("Hello World", set(), 10)  # type: ignore[misc]
