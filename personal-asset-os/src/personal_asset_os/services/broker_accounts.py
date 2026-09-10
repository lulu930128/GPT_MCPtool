"""Explicit local account setup; never imports example balances or broker transactions."""
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.errors import ConflictError
from personal_asset_os.models import Account, AppSetting
from personal_asset_os.services.ledger import create_account

KEY = "broker_cash_account_id"


def setup(session: Session, configured_id: str | None = None) -> dict[str, str]:
    # Serialize setup with existing settings; account names also have a unique constraint.
    session.execute(update(AppSetting).where(AppSetting.key == "base_currency")
                    .values(value=AppSetting.value))
    result: dict[str, str] = {}
    for name, subtype in (("凱基 e財庫", AccountSubtype.BROKER_CASH),
                          ("凱基投資", AccountSubtype.INVESTMENT)):
        account = session.scalar(select(Account).where(Account.name == name))
        if account is None:
            if subtype == AccountSubtype.BROKER_CASH and (
                configured_id or session.get(AppSetting, KEY)
            ):
                raise ConflictError("已有券商現金對應，請先確認既有帳戶")
            account = create_account(session, name=name, kind=AccountKind.ASSET,
                                     subtype=subtype, institution="KGI", is_liquid=False)
        if (account.kind != AccountKind.ASSET or account.subtype != subtype
                or not account.is_active or account.is_system or account.currency != "TWD"
                or account.is_liquid):
            raise ConflictError("同名帳戶設定不符，請先確認既有帳戶")
        result[subtype.value] = account.id
    if configured_id and configured_id != result["broker_cash"]:
        raise ConflictError("環境設定已對應其他現金帳戶，未變更對應")
    setting = session.get(AppSetting, KEY)
    if setting and setting.value != result["broker_cash"]:
        raise ConflictError("已有其他券商現金對應，未變更對應")
    if setting is None:
        session.add(AppSetting(key=KEY, value=result["broker_cash"]))
    session.flush()
    return result
