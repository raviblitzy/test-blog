## ===========================================================================
## Alembic revision template.
##
## Mako renders this file once per new revision, into
## migrations/versions/<rev>_<slug>.py -- the `<rev>_<slug>` shape comes from
## `file_template` in alembic.ini, not from here -- whenever anyone runs, from
## backend/, the canonical working directory that alembic.ini declares:
##
##     alembic revision -m "message"                 hand-authored revision
##     alembic revision --autogenerate -m "message"  diffed against the models
##     alembic merge -m "message" <rev> <rev>        same generator
##
## This file is never imported and never executed as Python; only its OUTPUT
## is. Its whole contract is therefore about the shape of that output:
##
##   * Every revision ships BOTH upgrade() and downgrade(), unconditionally.
##     That is what turns `alembic downgrade base` from a matter of author
##     discipline into a structural property of the revision tree: there is no
##     way to author a revision here that silently lacks a downgrade.
##   * The emitted Python is already ruff-clean and ruff-format-clean, because
##     migrations/ is deliberately NOT excluded from `ruff check backend` or
##     `ruff format --check backend`. Every blank line below is placed
##     accordingly; see the notes at each one.
##
## Lines starting with `##` are Mako comments. They are consumed at render time
## and reach no generated revision, which is why the reasoning here can be this
## detailed while adding zero boilerplate to the schema history. Everything not
## commented out IS emitted, verbatim or interpolated.
##
## The variables interpolated below are supplied by
## alembic.script.base.ScriptDirectory.generate_revision():
##
##     message        the -m text, or "empty message"; never None
##     up_revision    str(revid); always a string
##     down_revision  None for the base revision, else the parent id
##     branch_labels  None, or a tuple
##     depends_on     None, a single id, or a tuple
##     create_date    a datetime, rendered UTC per `timezone` in alembic.ini
##     imports        autogenerate only; "\n".join(sorted(...)) of import lines
##     upgrades       autogenerate only; rendered operations
##     downgrades     autogenerate only; the reverse operations
##
## The last three are absent on the plain `alembic revision` path, where Mako
## resolves them to UNDEFINED. `bool(UNDEFINED)` is False, which is exactly why
## every one of them is read through an `if ... else` guard: drop the guard and
## a hand-authored revision fails to render at all.
## ===========================================================================
##
## --- Docstring --------------------------------------------------------------
## Triple-DOUBLE quotes, deliberately: an author's message routinely contains
## an apostrophe ("don't drop the index"), and the message is the only wholly
## unconstrained text in this file. It also always has `\n\nRevision ID:` after
## it, so it can never sit adjacent to the closing quotes.
##
## `Revises: ${down_revision}` is plain, WITHOUT alembic's stock `| comma,n`
## filter. That filter routes through util.format_as_comma, which maps None to
## the empty string, so on the base revision the stock template emits
## "Revises: " with a trailing space -- which ruff's formatter strips and
## .editorconfig's trim_trailing_whitespace forbids. Rendering the value
## directly yields "Revises: None", which is both clean and honest: it matches
## the `down_revision` identifier below rather than hiding it.
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision}
Create Date: ${create_date}

"""
##
## --- Imports ----------------------------------------------------------------
## The blank line after the docstring is REQUIRED: ruff's formatter inserts one
## there, so omitting it would make every generated revision fail
## `ruff format --check`.
##
## Ordering is ruff's isort ordering, not alembic's stock ordering. Standard
## library first, then a blank line, then third party with straight `import x`
## before `from x import y` (force-sort-within-sections is off). alembic's own
## template puts `from alembic import op` first, which is I001-unsorted here.
##
## `Sequence` comes from collections.abc rather than typing: the interpreter is
## pinned to 3.14.7 in .python-version, where the typing aliases are deprecated
## and ruff's UP rules flag them. It is genuinely used, by the branch_labels and
## depends_on annotations below, so it is never a dangling import.

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
## The `imports` insertion point. LOAD-BEARING, and the single most commonly
## dropped line in a hand-written script.py.mako: autogenerate injects its
## dialect-specific imports here and nowhere else. This project needs it --
## `from sqlalchemy.dialects import postgresql` is how revisions reach UUID,
## native ENUM and TSVECTOR -- so losing it would break --autogenerate for most
## of the schema, silently, until someone read a generated diff closely.
##
## It stays BELOW the two imports above so the result is already sorted:
## `alembic` < `sqlalchemy.dialects` among the from-imports.
##
## The `+ "\n"` is what keeps the blank-line count invariant, and it is not
## optional. This line supplies one newline of its own either way, so:
##   imports empty     -> "" + this line's newline          = one blank line
##   imports non-empty -> the import lines + a trailing "\n" = one blank line
## Ruff's isort wants exactly one blank line after the import block; a bare
## `${imports if imports else ""}` gives two when empty and none when populated,
## and so trips I001 on one path or the other whatever follows it.
${imports + "\n" if imports else ""}
# revision identifiers, used by Alembic.
##
## Read by alembic's script scanner, not by any code in the revision, which is
## why four otherwise-unreferenced module globals are correct here.
##
## `repr()` rather than hand-written quotes. repr() renders a correct Python
## literal for a string AND for None, so the base revision gets the None
## keyword; interpolating into hand-written quotes would give it the *string*
## "None", a parent id that matches no revision. repr() quotes with apostrophes
## while [tool.ruff.format] asks for double; alembic.ini's ruff_format
## post-write hook normalises that on the way to disk, which is what it is for.
##
## PEP 604 unions throughout -- no Optional, no Union -- per the pinned 3.14
## interpreter and ruff's UP rules.
##
## down_revision is annotated `str | None`, narrower than alembic's stock
## `str | Sequence[str] | None`. This project's history is strictly linear
## (0001 -> 0002 -> 0003) and nothing in its workflow branches. Anyone who ever
## runs `alembic merge` should widen this line to match branch_labels below,
## because down_revision is a tuple for a merge revision.
revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}
##
## --- Migration bodies -------------------------------------------------------
## Two blank lines before each def, and none after the last line of the file
## beyond its single trailing newline: that is what ruff's formatter expects, so
## the generated file passes `ruff format --check` unaltered.
##
## Both functions are emitted always. downgrade() is never conditional, never
## commented out, and never a `raise NotImplementedError` -- a raise would turn
## the reversibility gate into a runtime failure, whereas `pass` leaves a valid
## revision with an obviously empty body for the author to fill.
##
## The four literal spaces before each placeholder are the body's indentation.
## alembic pre-indents continuation lines by four and strips the first line's
## indent, so the leading spaces here are what line the first operation up.
##
## No generic "Upgrade schema." docstring on either function: it would restate
## the name in every revision forever, and ruff's D rules are not enabled, so
## nothing asks for it. A revision that needs explanation carries it in the
## module docstring above, where the -m message already is.


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
