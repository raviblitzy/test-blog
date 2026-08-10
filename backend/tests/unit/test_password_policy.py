"""What ``app.schemas.auth``'s password policy accepts, refuses, and says while refusing.

The policy is three rules over a candidate string - a length floor, a length ceiling, and how many
of five character groups the string draws on - and it is applied on two paths that cannot see each
other. ``app.schemas.auth`` enforces it on ``POST /api/v1/auth/register`` and publishes the
numbers in ``/openapi.json``, while ``app.core.config`` applies it to ``SEED_ADMIN_PASSWORD`` as
:class:`~app.core.config.Settings` is constructed. One rule, two consumers, and this module is where
the rule itself is pinned.

Why a dedicated module rather than more registration cases
----------------------------------------------------------
``tests/integration/test_auth_api.py`` drives the policy the way a caller meets it: two rejected
passwords, one too short and one of a single alphabet, asserted through a 422 problem document. That
is the right test for the *route* and the wrong test for the *rule*. It exercises two points of a
three-dimensional space through an HTTP round trip, a schema layer and an exception handler, so a
defect in the classifier - a group that stops counting, a boundary that shifts by one - is invisible
unless it happens to change one of those two verdicts.

So the boundaries are pinned here instead, against the functions themselves:

* **exactly at** the floor and the ceiling, and **one either side** of each, so an ``<`` that became
  ``<=`` fails by name rather than by a route test that happened to use a twenty-character password;
* **each of the five groups** in isolation and in combination, including the pairs that reach
  exactly two groups and are therefore refused, so the count is asserted rather than assumed;
* **caseless scripts**, which are the reason the fourth group exists at all: a rule built only from
  lowercase, uppercase, digit and symbol is unsatisfiable at three groups for a Japanese or Hebrew
  passphrase however long it is, and the classifier's totality is what stops the policy quietly
  excluding most of the world's readers;
* **the message**, which must name the rule and never quote the candidate. ``app.core.exceptions``
  copies a validator's message verbatim into the problem document, so a message that echoed the
  password would put a rejected credential in a response body and in an access log.

Every value is parameterised from the production constants rather than written as a literal. A test
that hard-coded ``12`` would keep passing if the floor were raised to fourteen while the schema, the
field description and the message all moved - which is the one failure a boundary suite exists to
catch.

No user rules govern this file
------------------------------
``review_rules`` reports that this project specifies none, so the work is held to the AAP's own
enterprise standards (§0.10.1) instead. Two bind here: **secure-by-default authentication**, of
which the password rule is the first gate, and **blocking quality gates** - this module is fast,
imports
nothing but the standard library and the policy module, and is marked ``unit`` so ``pytest -m unit``
selects it without a database.

Deliberately out of scope
-------------------------
* **Hashing and verification.** ``app.core.security`` owns argon2id and is covered by
  ``tests/unit/test_security.py``. The policy module deliberately imports none of it.
* **The HTTP shape of a rejection.** ``tests/integration/test_auth_api.py`` owns the 422 problem
  document, its ``errors`` list and the field name it points at. This module asserts the verdict and
  its wording; that one asserts how the verdict travels.
* **The seeded-administrator variant.** The ``SEED_ADMIN_PASSWORD`` validator in
  ``app.core.config`` calls the same function through the same public name, and
  ``tests/unit/test_security.py`` covers the
  settings layer, so re-asserting the rule through a second consumer would test the wiring rather
  than the rule.
"""

from __future__ import annotations

import string
from typing import Final

import pytest

from app.schemas.auth import (
    PASSWORD_CHARACTER_GROUPS,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_CHARACTER_CLASSES,
    PASSWORD_MIN_LENGTH,
    PASSWORD_VARIETY_MESSAGE,
    password_character_groups,
    password_policy_violation,
)

# Fast, isolated, and touching neither the database nor the network - the marker
# `backend/pyproject.toml` registers for exactly this. Applied at module scope so `-m unit`
# selects the whole file.
pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------------------
# Group indices, restated
#
# `app.schemas.auth` keeps its `_GROUP_*` constants private, which is correct - they are
# positions in `PASSWORD_CHARACTER_GROUPS` and not part of the contract. This module needs to name
# them to assert *which* group a character lands in, so it derives each one from the published
# tuple by looking up the phrase, rather than hard-coding 0..4. A group reordered upstream then
# moves these with it; a group renamed fails loudly here instead of silently asserting the wrong
# index.
# ---------------------------------------------------------------------------------------


def _group_index(fragment: str) -> int:
    """Return the index of the published group phrase containing ``fragment``.

    Args:
        fragment: A distinctive substring of one of the five phrases.

    Returns:
        That phrase's position in :data:`PASSWORD_CHARACTER_GROUPS`, which is the index
        :func:`password_character_groups` reports.

    Raises:
        AssertionError: If no phrase contains it, or more than one does. Either means the
            published wording changed and this module's assumption about it is stale.
    """
    matches = [
        index for index, phrase in enumerate(PASSWORD_CHARACTER_GROUPS) if fragment in phrase
    ]
    assert len(matches) == 1, (
        f"{fragment!r} matches {len(matches)} of the published group phrases "
        f"{PASSWORD_CHARACTER_GROUPS}; this module's group lookup is stale."
    )
    return matches[0]


GROUP_LOWERCASE: Final[int] = _group_index("lowercase letter")
GROUP_UPPERCASE: Final[int] = _group_index("uppercase letter")
GROUP_DIGIT: Final[int] = _group_index("a digit")
GROUP_CASELESS: Final[int] = _group_index("no letter case")
GROUP_OTHER: Final[int] = _group_index("any other character")

#: One representative character per group, and every one of them a single code point, so a length
#: built by repetition is a length in the units the policy measures.
REPRESENTATIVES: Final[dict[int, str]] = {
    GROUP_LOWERCASE: "a",
    GROUP_UPPERCASE: "Q",
    GROUP_DIGIT: "7",
    # Hiragana `か`: a letter in a script that draws no case distinction, so `islower()` and
    # `isupper()` are both false while `isalpha()` is true.
    GROUP_CASELESS: "か",
    GROUP_OTHER: "-",
}


def _padded(*characters: str, length: int | None = None) -> str:
    """Build a candidate of exactly ``length`` code points drawing on ``characters``.

    The characters are cycled, so every one of them appears at least once as long as ``length`` is
    at least their number. Padding matters because the length rule is reported *before* the variety
    rule: a two-group candidate has to clear the floor before its variety can be the verdict, and a
    test that forgot to pad would be asserting the length message while believing it asserted the
    variety one.

    Args:
        *characters: One or more single code points to draw on, in order.
        length: The exact number of code points to produce. Defaults to the policy floor, which is
            the shortest acceptable length and therefore the most useful default.

    Returns:
        A string of exactly that many code points.
    """
    size = PASSWORD_MIN_LENGTH if length is None else length
    assert characters, "a candidate needs at least one character to draw on"
    assert size >= len(characters), "the length must be able to hold every named character"
    return "".join(characters[index % len(characters)] for index in range(size))


#: A candidate that satisfies every rule: three groups, exactly at the length floor. The baseline
#: the boundary cases are perturbations of.
VALID_MINIMUM: Final[str] = _padded(
    REPRESENTATIVES[GROUP_LOWERCASE],
    REPRESENTATIVES[GROUP_UPPERCASE],
    REPRESENTATIVES[GROUP_DIGIT],
)

#: The exact wording each length rule produces, interpolated from the constants for the same reason
#: the candidates are: a literal here would keep passing after the numbers moved.
TOO_SHORT_MESSAGE: Final[str] = f"Password must be at least {PASSWORD_MIN_LENGTH} characters."
TOO_LONG_MESSAGE: Final[str] = f"Password must be at most {PASSWORD_MAX_LENGTH} characters."


# ---------------------------------------------------------------------------------------
# The constants themselves
# ---------------------------------------------------------------------------------------


class TestPublishedPolicy:
    """The three numbers and five phrases are coherent before anything is judged against them."""

    def test_the_length_window_is_ordered_and_usable(self) -> None:
        """The floor is below the ceiling, and both are values a human password can satisfy.

        A degenerate window - a floor above the ceiling, or a ceiling of zero - would make every
        candidate fail while every test that only checked *a* rejection still passed.
        """
        assert 0 < PASSWORD_MIN_LENGTH < PASSWORD_MAX_LENGTH
        # Written as literals on purpose: these two numbers are published in `/openapi.json`, in
        # the field descriptions and in `.env.example`, so a change to either is a contract change
        # and has to be made deliberately in more than one place.
        assert PASSWORD_MIN_LENGTH == 12
        assert PASSWORD_MAX_LENGTH == 128

    def test_the_variety_rule_is_satisfiable_and_not_trivial(self) -> None:
        """The required group count is at least two and no more than the number of groups.

        One group would make the rule vacuous; more than five would make it unsatisfiable. Three of
        five is the published policy, and it is asserted as a literal here because it is the one
        number a well-meaning edit is most likely to "simplify".
        """
        assert 1 < PASSWORD_MIN_CHARACTER_CLASSES <= len(PASSWORD_CHARACTER_GROUPS)
        assert PASSWORD_MIN_CHARACTER_CLASSES == 3
        assert len(PASSWORD_CHARACTER_GROUPS) == 5

    def test_the_variety_message_quotes_the_published_phrases(self) -> None:
        """Every group phrase appears in the message, and the message names the required count.

        The message is built from the tuple rather than written out, so this asserts that the
        construction still holds - a client renders this string beside the password field, and a
        message naming four groups while the policy counts five would be actively misleading.
        """
        assert str(PASSWORD_MIN_CHARACTER_CLASSES) in PASSWORD_VARIETY_MESSAGE
        assert str(len(PASSWORD_CHARACTER_GROUPS)) in PASSWORD_VARIETY_MESSAGE
        for phrase in PASSWORD_CHARACTER_GROUPS:
            assert phrase in PASSWORD_VARIETY_MESSAGE
        assert PASSWORD_VARIETY_MESSAGE.endswith(".")

    def test_the_representative_characters_map_to_distinct_groups(self) -> None:
        """This module's own fixtures land in the five groups it believes they do.

        A test-fixture assertion rather than a production one, and it earns its place: every
        variety case below is built from :data:`REPRESENTATIVES`, so a character that quietly
        classified elsewhere would make those cases assert something other than what they say.
        """
        assert len(REPRESENTATIVES) == len(PASSWORD_CHARACTER_GROUPS)
        for index, character in REPRESENTATIVES.items():
            assert len(character) == 1
            assert password_character_groups(character) == frozenset({index}), (
                f"{character!r} classifies as {sorted(password_character_groups(character))}, "
                f"not as group {index} ({PASSWORD_CHARACTER_GROUPS[index]})"
            )


# ---------------------------------------------------------------------------------------
# The classifier
# ---------------------------------------------------------------------------------------


class TestPasswordCharacterGroups:
    """:func:`password_character_groups` is total, order-independent and Unicode-aware."""

    def test_an_empty_string_draws_on_no_group(self) -> None:
        """The only input with an empty result, which the docstring states and this pins."""
        assert password_character_groups("") == frozenset()

    @pytest.mark.parametrize(
        ("character", "expected_group"),
        [
            pytest.param("a", GROUP_LOWERCASE, id="ascii-lowercase"),
            pytest.param("z", GROUP_LOWERCASE, id="ascii-lowercase-last"),
            # `é` is lowercase to Unicode, so the classifier must agree: a caller writing an
            # accented password gets the group its letter actually belongs to.
            pytest.param("é", GROUP_LOWERCASE, id="accented-lowercase"),
            pytest.param("A", GROUP_UPPERCASE, id="ascii-uppercase"),
            pytest.param("Ä", GROUP_UPPERCASE, id="accented-uppercase"),
            pytest.param("0", GROUP_DIGIT, id="ascii-digit-zero"),
            pytest.param("9", GROUP_DIGIT, id="ascii-digit-nine"),
            # A caseless letter: neither `islower()` nor `isupper()`, but `isalpha()`. Each of
            # these would land in the catch-all group under a four-group policy, which is what
            # made a three-group rule unsatisfiable for these scripts.
            pytest.param("か", GROUP_CASELESS, id="caseless-hiragana"),
            pytest.param("漢", GROUP_CASELESS, id="caseless-han"),
            pytest.param("א", GROUP_CASELESS, id="caseless-hebrew"),
            pytest.param("ب", GROUP_CASELESS, id="caseless-arabic"),
            pytest.param("अ", GROUP_CASELESS, id="caseless-devanagari"),
            pytest.param("ก", GROUP_CASELESS, id="caseless-thai"),
            pytest.param("한", GROUP_CASELESS, id="caseless-hangul"),
            pytest.param("!", GROUP_OTHER, id="symbol"),
            pytest.param(".", GROUP_OTHER, id="punctuation"),
            pytest.param(" ", GROUP_OTHER, id="space"),
            pytest.param("\t", GROUP_OTHER, id="tab"),
            pytest.param("€", GROUP_OTHER, id="currency-sign"),
            # An astral code point: one character to Python, two UTF-16 units to a browser. It is
            # not a letter or a digit, so it lands in the catch-all - and, more importantly, it
            # counts as ONE towards the length rule, which the boundary cases below rely on.
            pytest.param("😀", GROUP_OTHER, id="astral-emoji"),
        ],
    )
    def test_a_single_character_lands_in_exactly_one_group(
        self, character: str, expected_group: int
    ) -> None:
        """Classification is total and exclusive: one character, one group, never zero or two."""
        assert password_character_groups(character) == frozenset({expected_group})

    @pytest.mark.parametrize("character", ["a", "A", "7", "か", "-", " ", "😀"])
    def test_repetition_does_not_add_groups(self, character: str) -> None:
        """Twenty copies of one character still draw on one group.

        The property that makes ``aaaaaaaaaaaaaaaaaaaa`` a refusal rather than an acceptance: it
        clears the length floor comfortably and is still a single-alphabet password.
        """
        assert password_character_groups(character * 20) == password_character_groups(character)

    def test_every_group_is_reachable_at_once(self) -> None:
        """A candidate drawing on all five reports all five, so no group shadows another.

        The classifier tests its four conditions in order and catches the rest in an ``else``, so a
        condition placed too early - ``isalpha`` before the case tests, say - would collapse two
        groups into one and pass every single-character case above that happened to be checked
        first.
        """
        candidate = "".join(REPRESENTATIVES[index] for index in sorted(REPRESENTATIVES))

        assert password_character_groups(candidate) == frozenset(REPRESENTATIVES)

    def test_the_result_does_not_depend_on_order(self) -> None:
        """The same characters in any arrangement report the same groups."""
        forwards = "".join(REPRESENTATIVES[index] for index in sorted(REPRESENTATIVES))
        backwards = forwards[::-1]

        assert password_character_groups(forwards) == password_character_groups(backwards)

    def test_classification_covers_the_whole_printable_ascii_range(self) -> None:
        """No printable ASCII character is left unclassified, and each lands in one group.

        Totality asserted exhaustively over the range every keyboard produces, rather than at a
        handful of sampled points. The counts are also pinned: the twenty-six lower-case letters,
        the twenty-six upper-case, the ten digits, and everything else - punctuation and the space -
        in the catch-all, with nothing in the caseless group because Latin script has case.
        """
        for character in string.printable:
            groups = password_character_groups(character)
            assert len(groups) == 1, f"{character!r} classified as {sorted(groups)}"

        assert password_character_groups(string.ascii_lowercase) == frozenset({GROUP_LOWERCASE})
        assert password_character_groups(string.ascii_uppercase) == frozenset({GROUP_UPPERCASE})
        assert password_character_groups(string.digits) == frozenset({GROUP_DIGIT})
        assert password_character_groups(string.punctuation) == frozenset({GROUP_OTHER})
        assert GROUP_CASELESS not in password_character_groups(string.printable)


# ---------------------------------------------------------------------------------------
# The length rule, at and either side of both bounds
# ---------------------------------------------------------------------------------------


class TestLengthBoundaries:
    """The floor and the ceiling are exact, and both are measured in code points."""

    def test_exactly_at_the_floor_is_accepted(self) -> None:
        """A candidate of exactly :data:`PASSWORD_MIN_LENGTH` characters passes.

        The half of the boundary a ``<=`` would break, and the reason the pair is asserted
        together: a floor test that only checked "eleven is refused" would pass under an
        off-by-one that also refused twelve.
        """
        assert len(VALID_MINIMUM) == PASSWORD_MIN_LENGTH
        assert password_policy_violation(VALID_MINIMUM) is None

    def test_one_below_the_floor_is_refused_with_the_length_message(self) -> None:
        """One character short is refused, naming the floor rather than the variety rule."""
        candidate = VALID_MINIMUM[:-1]

        assert len(candidate) == PASSWORD_MIN_LENGTH - 1
        assert password_policy_violation(candidate) == TOO_SHORT_MESSAGE

    def test_exactly_at_the_ceiling_is_accepted(self) -> None:
        """A candidate of exactly :data:`PASSWORD_MAX_LENGTH` characters passes."""
        candidate = _padded(
            REPRESENTATIVES[GROUP_LOWERCASE],
            REPRESENTATIVES[GROUP_UPPERCASE],
            REPRESENTATIVES[GROUP_DIGIT],
            length=PASSWORD_MAX_LENGTH,
        )

        assert len(candidate) == PASSWORD_MAX_LENGTH
        assert password_policy_violation(candidate) is None

    def test_one_above_the_ceiling_is_refused_with_the_length_message(self) -> None:
        """One character over is refused, which is the denial-of-service bound doing its job.

        argon2id is memory-hard and deliberately slow, and registration is unauthenticated, so an
        unbounded input on that route is an amplification primitive. The bound also has to hold
        against ``LoginRequest``, or a seeded administrator could be given a credential that hashes
        and stores and is then refused at every sign-in.
        """
        candidate = _padded(
            REPRESENTATIVES[GROUP_LOWERCASE],
            REPRESENTATIVES[GROUP_UPPERCASE],
            REPRESENTATIVES[GROUP_DIGIT],
            length=PASSWORD_MAX_LENGTH + 1,
        )

        assert len(candidate) == PASSWORD_MAX_LENGTH + 1
        assert password_policy_violation(candidate) == TOO_LONG_MESSAGE

    @pytest.mark.parametrize(
        "length",
        [0, 1, PASSWORD_MIN_LENGTH // 2, PASSWORD_MIN_LENGTH - 2, PASSWORD_MIN_LENGTH - 1],
    )
    def test_every_length_below_the_floor_is_refused(self, length: int) -> None:
        """Shorter than the floor is refused whatever the variety, and reported as a length fault.

        Parameterised down to the empty string, because zero is the input a naive implementation
        divides by, indexes into, or lets through as "nothing to check".
        """
        # Built by slicing a three-group cycle rather than through `_padded`, because a length of
        # one cannot hold three distinct characters and the point here is the length verdict, not
        # the variety of a one-character string.
        candidate = ("aQ7" * PASSWORD_MIN_LENGTH)[:length]

        assert len(candidate) == length
        assert password_policy_violation(candidate) == TOO_SHORT_MESSAGE

    def test_length_is_counted_in_code_points_not_utf16_units(self) -> None:
        """An astral character counts as one, so a passphrase of emoji is measured honestly.

        Python counts code points and a browser's ``String.length`` counts UTF-16 units, so a
        candidate of exactly the floor in emoji is twice that in the units a client might report.
        The server's rule is the code-point one, and pinning it here is what stops a future
        "normalise the length" edit from silently accepting half-length passwords - or refusing
        full-length ones.
        """
        astral = "😀"
        assert len(astral) == 1, "the fixture must be a single code point to make the point"

        # The floor's worth of astral characters plus two more groups: long enough by the rule
        # this module asserts, and only half as long in UTF-16 units.
        candidate = astral * (PASSWORD_MIN_LENGTH - 2) + "aA"

        assert len(candidate) == PASSWORD_MIN_LENGTH
        assert len(candidate.encode("utf-16-le")) // 2 > PASSWORD_MIN_LENGTH
        assert password_policy_violation(candidate) is None

    def test_whitespace_is_significant_and_never_trimmed(self) -> None:
        """Surrounding spaces count towards the length and are not stripped.

        Trimming would change the credential, so a candidate that is only long enough *with* its
        spaces must be accepted with them - and the same string trimmed must be refused, which is
        what proves nothing in the policy normalises its input.
        """
        padded = "  " + "aA7" * 4  # 14 characters, three groups plus the two leading spaces.
        trimmed = padded.strip()

        assert password_policy_violation(padded) is None
        assert len(trimmed) == len(padded) - 2
        assert password_policy_violation(trimmed) is None
        # And a candidate that relies on its whitespace for length is accepted as submitted while
        # its trimmed form is not.
        borderline = " " * 3 + "aA7" * 3  # 12 with the spaces, 9 without.
        assert len(borderline) == PASSWORD_MIN_LENGTH
        assert password_policy_violation(borderline) is None
        assert password_policy_violation(borderline.strip()) == TOO_SHORT_MESSAGE


# ---------------------------------------------------------------------------------------
# The variety rule
# ---------------------------------------------------------------------------------------


class TestVarietyBoundaries:
    """Exactly the required number of groups is enough; one fewer is not."""

    @pytest.mark.parametrize("group", sorted(REPRESENTATIVES))
    def test_a_single_group_is_refused_however_long(self, group: int) -> None:
        """One group is refused at the floor and at the ceiling alike.

        Length does not substitute for variety and variety does not substitute for length; the two
        rules are independent, and asserting the single-group case at both ends is what shows it.
        """
        for length in (PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH):
            candidate = REPRESENTATIVES[group] * length

            assert password_policy_violation(candidate) == PASSWORD_VARIETY_MESSAGE

    @pytest.mark.parametrize(
        ("first", "second"),
        [
            pytest.param(GROUP_LOWERCASE, GROUP_UPPERCASE, id="lower-and-upper"),
            pytest.param(GROUP_LOWERCASE, GROUP_DIGIT, id="lower-and-digit"),
            pytest.param(GROUP_UPPERCASE, GROUP_DIGIT, id="upper-and-digit"),
            pytest.param(GROUP_LOWERCASE, GROUP_OTHER, id="lower-and-symbol"),
            # The pair that motivates the fourth group: a caseless script plus punctuation reaches
            # two and can reach no further, however long the passphrase.
            pytest.param(GROUP_CASELESS, GROUP_OTHER, id="caseless-and-symbol"),
            pytest.param(GROUP_CASELESS, GROUP_DIGIT, id="caseless-and-digit"),
        ],
    )
    def test_exactly_two_groups_is_one_short_and_refused(self, first: int, second: int) -> None:
        """Two groups at full length is refused with the variety message, not the length one.

        The sharpest boundary in the rule: the candidate satisfies the length floor, so the only
        thing standing between it and acceptance is the group count, and the message must say so.
        """
        candidate = _padded(REPRESENTATIVES[first], REPRESENTATIVES[second])

        assert len(candidate) == PASSWORD_MIN_LENGTH
        assert len(password_character_groups(candidate)) == PASSWORD_MIN_CHARACTER_CLASSES - 1
        assert password_policy_violation(candidate) == PASSWORD_VARIETY_MESSAGE

    @pytest.mark.parametrize(
        ("first", "second", "third"),
        [
            pytest.param(GROUP_LOWERCASE, GROUP_UPPERCASE, GROUP_DIGIT, id="lower-upper-digit"),
            pytest.param(GROUP_LOWERCASE, GROUP_UPPERCASE, GROUP_OTHER, id="lower-upper-symbol"),
            pytest.param(GROUP_LOWERCASE, GROUP_DIGIT, GROUP_OTHER, id="lower-digit-symbol"),
            # The combination the fourth group exists for: a caseless passphrase reaches three
            # only because caseless letters count as a group of their own.
            pytest.param(GROUP_CASELESS, GROUP_DIGIT, GROUP_OTHER, id="caseless-digit-symbol"),
            pytest.param(GROUP_CASELESS, GROUP_LOWERCASE, GROUP_UPPERCASE, id="caseless-and-cased"),
        ],
    )
    def test_exactly_the_required_groups_is_enough(
        self, first: int, second: int, third: int
    ) -> None:
        """Three groups at the length floor is accepted - the minimum acceptable candidate.

        Asserted for several different triples, including two that involve a caseless script,
        because "three of five" must not quietly mean "three of the four Latin ones".
        """
        candidate = _padded(REPRESENTATIVES[first], REPRESENTATIVES[second], REPRESENTATIVES[third])

        assert len(password_character_groups(candidate)) == PASSWORD_MIN_CHARACTER_CLASSES
        assert password_policy_violation(candidate) is None

    def test_all_five_groups_is_accepted(self) -> None:
        """More variety than required is not penalised."""
        candidate = _padded(*[REPRESENTATIVES[index] for index in sorted(REPRESENTATIVES)])

        assert len(password_character_groups(candidate)) == len(PASSWORD_CHARACTER_GROUPS)
        assert password_policy_violation(candidate) is None

    def test_a_caseless_passphrase_is_not_excluded_by_length_alone(self) -> None:
        """A long Japanese passphrase is refused for its variety, never for being non-Latin.

        The concrete form of the exclusion the fifth and fourth groups exist to prevent: this
        candidate is well over the floor and draws on one group, so the verdict is the variety
        message - the same verdict an all-lowercase Latin password gets, and not a different or
        harsher one.
        """
        passphrase = "ひらがなだけでかいたぱすわーど"

        assert len(passphrase) > PASSWORD_MIN_LENGTH
        assert password_character_groups(passphrase) == frozenset({GROUP_CASELESS})
        assert password_policy_violation(passphrase) == PASSWORD_VARIETY_MESSAGE
        # And the same passphrase with a digit and a symbol clears the rule.
        assert password_policy_violation(f"{passphrase}7-") is None


# ---------------------------------------------------------------------------------------
# Rule ordering, and what a message may contain
# ---------------------------------------------------------------------------------------


class TestVerdictOrderingAndDisclosure:
    """One actionable sentence at a time, and never a word of the candidate."""

    def test_length_is_reported_before_variety(self) -> None:
        """A candidate failing both rules is told about the length only.

        Deliberate ordering rather than an accident of the ``if`` chain: a caller who typed four
        characters gets one instruction to act on rather than two, and the second becomes relevant
        only once the first is satisfied. Asserted from both directions - the short single-group
        candidate reports length, and the same candidate lengthened reports variety - so the
        ordering cannot be satisfied by a message that mentions both.
        """
        short_and_uniform = "aaa"

        assert password_policy_violation(short_and_uniform) == TOO_SHORT_MESSAGE
        assert password_policy_violation(short_and_uniform) != PASSWORD_VARIETY_MESSAGE
        assert password_policy_violation("a" * PASSWORD_MIN_LENGTH) == PASSWORD_VARIETY_MESSAGE

    def test_the_long_candidate_reports_the_ceiling_before_variety(self) -> None:
        """Over the ceiling and single-group reports the ceiling, for the same reason."""
        candidate = "a" * (PASSWORD_MAX_LENGTH + 1)

        assert password_policy_violation(candidate) == TOO_LONG_MESSAGE

    @pytest.mark.parametrize(
        "candidate",
        [
            pytest.param("hunter2", id="short-and-recognisable"),
            pytest.param("correct horse battery", id="two-groups-with-spaces"),
            pytest.param("ALLUPPERCASELETTERS", id="single-group-upper"),
            pytest.param("a" * (PASSWORD_MAX_LENGTH + 5), id="over-the-ceiling"),
            pytest.param("ひらがなだけ", id="caseless-and-short"),
        ],
    )
    def test_no_message_quotes_the_candidate(self, candidate: str) -> None:
        """A rejection names the rule and never the value, at any length or in any script.

        This is a confidentiality property, not a wording preference.
        ``app.core.exceptions`` copies a validator's message verbatim into the ``message`` member
        of the problem document's ``errors`` list, and ``ValidationErrorItem`` drops pydantic's
        ``input`` key for the same reason - so a message that echoed the candidate would put a
        rejected password into a response body and into every access log that records one.

        Asserted at two granularities, because a partial leak is still a leak: the whole candidate,
        and each whitespace-separated word of it - a passphrase leaked one word at a time is leaked.

        Deliberately **not** asserted at the level of arbitrary short substrings. The messages are
        English sentences naming the rule, so they legitimately contain fragments such as ``tter``
        (from "letter") that a passphrase like "correct horse battery" also contains; a
        four-character-window check reports that coincidence as a disclosure and would have to be
        suppressed case by case, which is how a test stops meaning anything. The property that
        matters and is checked is that no token of the candidate reaches the verdict.
        """
        verdict = password_policy_violation(candidate)
        assert verdict is not None, "these candidates are all invalid by construction"

        assert candidate not in verdict
        for word in candidate.split():
            assert word not in verdict, f"the verdict quotes the word {word!r}"

    def test_an_acceptable_candidate_produces_no_message_at_all(self) -> None:
        """Acceptance is ``None``, not an empty string, so a caller can test it with ``is None``.

        The distinction matters at the call sites: ``app.schemas.auth`` and ``app.core.config`` both
        branch on the return value, and an empty string is falsy in the same way ``None`` is but is
        not the documented contract - a caller writing ``if violation is not None`` would then raise
        on every valid password.
        """
        verdict = password_policy_violation(VALID_MINIMUM)

        assert verdict is None
        assert verdict is not ""  # noqa: F632 - identity is the point; `== ""` would not be

    def test_the_two_length_messages_are_distinguishable(self) -> None:
        """Too short and too long are different sentences, so a caller knows which way to move."""
        assert TOO_SHORT_MESSAGE != TOO_LONG_MESSAGE
        assert password_policy_violation("aA7") == TOO_SHORT_MESSAGE
        assert password_policy_violation("aA7" * 100) == TOO_LONG_MESSAGE
