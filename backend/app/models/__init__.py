"""The single metadata view: every relation in the blog schema, re-exported from one place.

Six sibling modules declare the schema, and this package is what makes them a *set*. Importing
``app.models`` imports all six, and importing all six is what attaches all seven relations to the
one :class:`~sqlalchemy.MetaData` that ``app.db.base`` owns. No other module in the backend
performs that assembly, which is why this file is structurally load-bearing rather than a
formality - and why it is written last, after every module it names already exists.

The emptiness of the alternative is worth stating plainly. Python would treat ``app.models`` as an
implicit namespace package even with this file absent, so ``import app.models`` would still
succeed - and import nothing. The shared metadata would then hold no relation at all, and every
consumer below would be reading an empty collection while raising no error.

Why completeness here decides whether a quality gate works
----------------------------------------------------------
Alembic's autogeneration compares the model-side collection against the live database, and a
relation enters that collection only once the module declaring it has been imported. An omission
here therefore does not raise; it silently *narrows the comparison*. A relation this file forgets
is a relation ``alembic check`` cannot see, and a check that cannot see a table reports no drift
for it - not an error, simply nothing to compare.

That is the one failure mode this file exists to prevent, and it is dangerous precisely because it
is quiet. The reversible-schema-evolution guarantee rests on three gates: ``alembic upgrade head``
against an empty database, ``alembic downgrade base`` followed by ``alembic upgrade head`` again,
and ``alembic check`` reporting nothing pending. The first two exercise the revision scripts and
fail loudly when those are wrong. Only the third can catch the models and the revisions drifting
apart, and the third is only ever as complete as the re-export list below. Completeness here is
the whole job.

Seven relations: six mapped classes and one Core Table
------------------------------------------------------
The count is worth spelling out, because the phrase "the mapped classes" quietly loses one
relation. The schema has **seven**:

* ``users`` - :class:`~app.models.user.User`
* ``refresh_tokens`` - :class:`~app.models.refresh_token.RefreshToken`
* ``categories`` - :class:`~app.models.category.Category`
* ``posts`` - :class:`~app.models.post.Post`
* ``post_categories`` - :data:`~app.models.category.post_categories`, a Core
  :class:`~sqlalchemy.Table` and **not** a mapped class
* ``comments`` - :class:`~app.models.comment.Comment`
* ``post_likes`` - :class:`~app.models.like.PostLike`

Six are declarative classes. ``post_categories`` is a pure join relation carrying no identity of
its own and no attribute a caller could set, so ``app.models.category`` declares it as a Table
instead - which makes it exactly the entry an enumeration of "classes" drops, and dropping it is
the silent narrowing described above. It is re-exported below alongside the six.

Enumerations travel with their relation
---------------------------------------
:class:`~app.models.user.UserRole`, :class:`~app.models.post.PostStatus` and
:class:`~app.models.comment.CommentStatus` are re-exported too, and that is a settled decision
rather than a convenience. Each is persisted as a native PostgreSQL enumerated type by the very
column that declares it, so an enum and its column have one owner and one address. ``app.schemas``
imports these three from here rather than declaring parallel copies of the same states: a second
declaration is a second source of truth, and the two would disagree the first time a state was
added on one side only.

Import order
------------
``app.models.category`` is imported before ``app.models.post``, matching the real dependency.
``app.models.post`` holds the one genuine run-time model-to-model import in this package, because
:paramref:`~sqlalchemy.orm.relationship.secondary` needs the ``post_categories`` Table object
itself and cannot be handed a name. Every other cross-model reference in the package is either a
string target or an annotation deferred under :data:`typing.TYPE_CHECKING`, so the import graph is
acyclic and Python would in fact resolve these six in any order. Ordering them to match the
dependency documents the edge rather than leaving a reader to rediscover it, and the linter's
alphabetical ordering happens to be that order, so the two constraints never compete.

No import-time side effects
---------------------------
Beyond the six imports there is nothing here: no engine, no connection, no schema-creation or DDL
call, no logging setup, no environment read, no mapper-configuration call, and no import of the
module that builds the async engine, of the typed settings module, or of the application factory.

The restraint is a correctness requirement, not a matter of taste. ``migrations/env.py`` imports
this package on every ``alembic upgrade head``, ``alembic downgrade base`` and ``alembic check``
invocation - that is the whole point of the package - so any eager side effect here would open a
connection to PostgreSQL or construct the FastAPI application on every migration command, before
any migration had been asked for. The identical contract already governs the three package
markers above and beside this one, at the application root, the cross-cutting foundation and the
data layer; this file keeps it. It is also what lets the test harness drive the application
in-process with nothing configured and no database reachable.

Why the declarative base is not re-exported
-------------------------------------------
:class:`~app.db.base.Base` and the shared metadata belong to ``app.db.base``, and they stay there.
Lifting either into this package would create a second import path to the same object and, with
it, a live question about which collection is authoritative - a question this schema cannot
afford, because a relation registered against a second collection is invisible to the migration
runner and the test harness alike. Every mapped class reaches the base class at its one address,
and so do both of those callers. This package re-exports relations; it does not re-export the
foundation they are built on.

Verifying completeness
----------------------
The property this file is answerable for reduces to one assertion, and it is worth knowing how to
make it::

    import app.models  # noqa: F401
    from app.db.base import Base

    assert len(Base.metadata.tables) == 7

Seven relations, every time, with the names listed above. Anything fewer means an import is
missing from this file, and it means the drift gate has stopped being able to see the difference.

Consumers of this surface
-------------------------
* ``migrations/env.py`` imports this package so that autogeneration and drift detection see all
  seven relations. This is the consumer the file exists for.
* ``app.db.seed`` imports :class:`~app.models.user.User`,
  :class:`~app.models.category.Category`, :class:`~app.models.post.Post`,
  :class:`~app.models.user.UserRole` and :class:`~app.models.post.PostStatus` from *here* rather
  than from the individual modules, so those five names are part of a contract.
* ``app.schemas.post``, ``app.schemas.user``, ``app.schemas.comment`` and ``app.schemas.admin``
  take the three enumerations from here instead of redeclaring them.
* The test harness and its factories construct users, categories, posts, comments and likes
  through these names.
* ``app.repositories.*`` and the request-scoped dependency layer import their mapped classes from
  the individual sibling modules directly, so they do not depend on this package - but nothing
  added here may break them either.

Dropping a name from :data:`__all__` is a breaking change to those consumers; dropping an import
is a breaking change to the drift gate. Both lists below are therefore append-only in practice:
a new relation adds a module import here in the same change that adds its revision.
"""

from app.models.category import Category, post_categories
from app.models.comment import Comment, CommentStatus
from app.models.like import PostLike
from app.models.post import Post, PostStatus
from app.models.refresh_token import RefreshToken
from app.models.user import User, UserRole

# Every name above is imported purely to be re-exported and none is referenced inside this
# module, which is the textbook shape the unused-import rule exists to catch. `__all__` is what
# distinguishes a deliberate public surface from an accident: it satisfies that rule without a
# per-line suppression, it tells the strict type checker these names are re-exported rather than
# incidentally visible, and it doubles as the documented contract the consumers named in the
# docstring hold this file to.
#
# The ordering is the linter's isort-style ordering for `__all__` - class-cased names first in
# natural order, then everything else - which is why `post_categories` trails the six classes and
# three enumerations despite being no less a part of the schema than any of them.
__all__ = [
    "Category",
    "Comment",
    "CommentStatus",
    "Post",
    "PostLike",
    "PostStatus",
    "RefreshToken",
    "User",
    "UserRole",
    "post_categories",
]
