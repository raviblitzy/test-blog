"""What makes a password acceptable, declared once and reachable from anywhere.

Two paths in this service judge a password, and this module is the single rule between them:

* ``app.schemas.auth`` publishes these numbers in ``/openapi.json`` and enforces them on
  ``POST /api/v1/auth/register``, so a reader is told the rule before submitting and rejected by
  it afterwards.
* ``app.core.config`` applies them to ``SEED_ADMIN_PASSWORD`` while :class:`Settings` is being
  constructed, so the seeded administrator - frequently the only ``ADMIN`` principal a deployment
  has, and the one account that cannot be created through the registration route - cannot be
  given a credential the registration route would have refused, or one so long that every later
  sign-in is rejected at the schema boundary.

Why the policy lives in a module of its own
-------------------------------------------
Because both of those consumers have to reach it, and only one of them can afford to be
configured.

The policy previously sat in ``app.core.config``, chosen because that module imports no ``app``
sibling and so could be reached from either direction. It cost more than it looked like it did.
Importing ``app.core.config`` constructs the :data:`~app.core.config.settings` singleton at
module scope - deliberately, so that a missing variable stops the process while it is still
starting - and that made a *contract* module depend on a *configured environment*. The
observable consequence was that ``import app.schemas`` failed with six ``Field required``
validation errors on a machine with no ``.env`` and no exported variables, because resolving the
package imports every sibling and ``app.schemas.auth`` reached ``app.core.config`` for four
constants and one classifier it needed at class-definition time. A schema module describes JSON;
it should not require a database URL to be importable.

Splitting the rule out fixes that at the root rather than papering over it. This module imports
**the standard library and nothing else** - no ``pydantic``, no ``pydantic-settings``, no
``app`` sibling, and no environment access of any kind - so it sits *below*
``app.core.config`` in the graph and both consumers import downwards. ``app.core.config``
re-exports every name here through its own ``__all__``, so ``from app.core.config import
PASSWORD_MIN_LENGTH`` still resolves for anything already written against it, and the rule is
still declared exactly once.

That leaves the layering intact in the direction that matters: ``app.core.config`` remains the
only module in the repository that reads the environment, and this module is not an exception to
it - it reads nothing at all.

Import purity, and why it is a requirement
------------------------------------------
Importing this module has no side effect: it constructs no settings, opens no connection, reads
no file, touches no environment variable and emits nothing. ``import app.core.password_policy``
therefore succeeds on a machine with nothing configured, which is precisely the property
``app.schemas`` needs from everything beneath it and the property the previous arrangement did
not have.

Deliberate exclusions
---------------------
* **No hashing, verification or comparison.** ``app.core.security`` owns argon2id, and it may not
  be reached from here: it imports ``app.core.config``, which imports this module.
* **No policy for anything other than a new password.** The minimum size of the HMAC signing key
  belongs to the algorithm it is used with, so it stays in ``app.core.config`` beside
  ``JWT_ALGORITHM``; and the published-placeholder check stays there too, because what counts as
  a placeholder is a fact about ``.env.example`` rather than about passwords.
* **No configurability.** These are constants rather than settings fields. ``.env.example`` is
  this repository's configuration contract and declares no password-policy key, so introducing
  one here would desynchronise that file from ``README.md``'s environment table,
  ``docker-compose.yml`` and the CI workflow - and a deployment that quietly lowered its own
  minimum length is not a knob worth offering.
* **No message about what was submitted.** Every string this module produces names the *rule*.
  ``app.core.exceptions`` copies a validator's message verbatim into the problem document, so a
  message quoting the candidate would put a rejected password in a response body and in an
  access log.
"""

from typing import Final

__all__ = [
    "PASSWORD_CHARACTER_GROUPS",
    "PASSWORD_MAX_LENGTH",
    "PASSWORD_MIN_CHARACTER_CLASSES",
    "PASSWORD_MIN_LENGTH",
    "PASSWORD_VARIETY_MESSAGE",
    "password_character_groups",
    "password_policy_violation",
]


PASSWORD_MIN_LENGTH: Final[int] = 12
"""Shortest accepted new password, in characters.

Length is the property that actually resists an offline attack on a stolen
``users.password_hash``: each additional character multiplies the search space, where a
composition rule only rearranges it. Twelve is the floor, and
:data:`PASSWORD_MIN_CHARACTER_CLASSES` is what keeps a twelve-character password from also
being a single-alphabet one.
"""

PASSWORD_MAX_LENGTH: Final[int] = 128
"""Longest accepted password, in characters, on registration and on login alike.

A denial-of-service bound rather than a storage limit. ``users.password_hash`` is unbounded
``TEXT`` precisely so an argon2id hash may grow when its cost parameters are tuned, and
``app.core.security.hash_password`` passes the plaintext through unmodified: argon2 is
memory-hard and intentionally slow, so an unbounded input on an unauthenticated route is an
amplification primitive. One hundred and twenty-eight characters is far above any password a
human composes, so the bound costs no legitimate caller anything.

It bounds ``SEED_ADMIN_PASSWORD`` for a second, sharper reason. ``LoginRequest`` applies this
same ceiling, so a longer seeded password would hash and store perfectly well and then be
refused at every login attempt - an administrator account that exists and cannot be used.
"""

PASSWORD_MIN_CHARACTER_CLASSES: Final[int] = 3
"""How many of the five character groups a new password must draw on.

Three of five. ``alllowercaseonly`` clears the length floor and is still trivially
enumerable, so requiring variety is what makes the stated minimum length mean something.
Three rather than all five, because a rule nobody can satisfy without a password manager is a
rule that produces written-down passwords. The groups are listed in
:data:`PASSWORD_CHARACTER_GROUPS`.
"""

PASSWORD_CHARACTER_GROUPS: Final[tuple[str, ...]] = (
    # Indexed by the _GROUP_* constants below, in this exact order. Adding a group means
    # adding its constant, its branch in password_character_groups, and a line here.
    "a lowercase letter",
    "an uppercase letter",
    "a digit",
    "a letter from a script that has no letter case, such as CJK, Hebrew or Arabic",
    "any other character, such as a symbol, a punctuation mark or a space",
)
"""The five character groups :data:`PASSWORD_MIN_CHARACTER_CLASSES` counts, as prose.

The list is the single source of the wording, so the field description a caller reads, the
validation message a rejected caller receives and any client mirroring the policy all quote
the same five phrases rather than three drifting paraphrases of them.

The **fifth group is a catch-all**, and that is what makes the classification total: every
character of every string lands in exactly one group, so no writing system is excluded by
omission. The fourth group is the reason the catch-all is not enough on its own. A rule built
only from "lowercase, uppercase, digit, symbol" is unsatisfiable at three groups for anyone
writing in a script that has no letter case - a Japanese or Hebrew passphrase can reach two
groups and no further, however long or strong it is - so counting caseless letters as a group
of their own is what keeps this policy from quietly excluding most of the world's readers.
"""

_GROUP_LOWERCASE: Final[int] = 0
_GROUP_UPPERCASE: Final[int] = 1
_GROUP_DIGIT: Final[int] = 2
_GROUP_CASELESS_LETTER: Final[int] = 3
_GROUP_OTHER: Final[int] = 4

PASSWORD_VARIETY_MESSAGE: Final[str] = (
    f"Password must contain characters from at least {PASSWORD_MIN_CHARACTER_CLASSES} of these "
    f"{len(PASSWORD_CHARACTER_GROUPS)} groups: {'; '.join(PASSWORD_CHARACTER_GROUPS)}."
)
"""The rejection message for a password that clears the length floor but not the group floor.

Built from :data:`PASSWORD_CHARACTER_GROUPS` rather than written out, so the message and the
documented policy cannot disagree. It is a complete, self-contained sentence on purpose:
``app.core.exceptions`` copies a validator's message verbatim into the ``message`` member of
each entry in the problem document's ``errors`` list, so this string is what a client renders
beside the password field. It names what is required and never quotes what was submitted -
``app.schemas.common.ValidationErrorItem`` drops pydantic's ``input`` key specifically so that
a rejected password cannot reach a response body or an access log.
"""


def password_character_groups(password: str) -> frozenset[int]:
    """Return the indices of :data:`PASSWORD_CHARACTER_GROUPS` the password draws on.

    Total by construction: the four tests are tried in order and the final ``else`` catches
    everything they do not, so every character contributes to exactly one group and no string
    is left unclassified. That totality is the property the fifth group exists to provide -
    see :data:`PASSWORD_CHARACTER_GROUPS` for why a four-group rule silently excluded caseless
    scripts.

    The tests are Unicode-aware because :meth:`str.islower`, :meth:`str.isupper` and
    :meth:`str.isdigit` are: ``é`` counts as lowercase and ``Ä`` as uppercase, exactly as ``e``
    and ``A`` do. ``isalpha`` is tried only after both case tests have failed, so it matches a
    letter from a script that draws no case distinction - Japanese, Chinese, Hebrew, Arabic,
    Devanagari, Thai, Hangul - rather than shadowing the two groups above it.

    Every character is examined rather than stopping once three groups have been found. Callers
    bound the input at :data:`PASSWORD_MAX_LENGTH`, so the loop is short, and returning the
    complete set keeps the result meaningful to a caller that wants to report what was present
    rather than only whether it was enough.

    Args:
        password: The candidate password, exactly as it was supplied.

    Returns:
        The set of group indices present. Empty only for an empty string.
    """
    groups: set[int] = set()
    for character in password:
        if character.islower():
            groups.add(_GROUP_LOWERCASE)
        elif character.isupper():
            groups.add(_GROUP_UPPERCASE)
        elif character.isdigit():
            groups.add(_GROUP_DIGIT)
        elif character.isalpha():
            groups.add(_GROUP_CASELESS_LETTER)
        else:
            groups.add(_GROUP_OTHER)
    return frozenset(groups)


def password_policy_violation(password: str) -> str | None:
    """Report why ``password`` is unacceptable as a new password, or ``None`` when it is fine.

    The whole policy in one call: too short, too long, or drawing on too few character groups.
    It returns a message rather than raising so that each caller can frame the failure for its
    own audience - ``app.schemas.auth`` reports it against the ``password`` member of a request
    body and ``app.core.config``'s ``SEED_ADMIN_PASSWORD`` validator reports it against an
    environment variable name - while the *rule* stays singular.

    Order matters. Length is reported before variety, so a caller who typed four characters is
    told the length rule rather than the length rule *and* the group rule at once, and has one
    actionable sentence to act on. ``app.schemas.auth`` reaches the same outcome from the other
    direction: its ``StringConstraints`` reject a length violation before any validator runs,
    so the only verdict this function ever returns there is the variety one.

    Nothing here trims, folds or re-encodes, and no message quotes the candidate. Whitespace is
    significant in a password - trimming it would change the credential - and a rejected
    password must not reach a validation message, a log line or a traceback.

    Args:
        password: The candidate password, exactly as it was supplied.

    Returns:
        A complete, self-contained sentence naming the first rule that was not met, or ``None``
        when the password satisfies every rule.
    """
    if len(password) < PASSWORD_MIN_LENGTH:
        return f"Password must be at least {PASSWORD_MIN_LENGTH} characters."
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"Password must be at most {PASSWORD_MAX_LENGTH} characters."
    if len(password_character_groups(password)) < PASSWORD_MIN_CHARACTER_CLASSES:
        return PASSWORD_VARIETY_MESSAGE
    return None
