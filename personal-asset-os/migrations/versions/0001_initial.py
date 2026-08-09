"""Initial append-only ledger schema.

Revision ID: 0001_initial
Revises:
Create Date: 2026-08-06
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Metadata owns the complete first schema. This migration remains explicit at the
    # revision boundary while keeping enum/check definitions identical to the models.
    from personal_asset_os import models  # noqa: F401
    from personal_asset_os.database import Base

    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    from personal_asset_os import models  # noqa: F401
    from personal_asset_os.database import Base

    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
