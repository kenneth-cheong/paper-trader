"""Sends the AI fund's orders to Tiger Brokers and brings back what happened to them.

Usage: python scripts/tiger_broker.py sync|send <ai-fund.json>
  sync  cancels orders the fund asked to cancel, refreshes the status and fills of open orders,
        and records the account's positions (runs before the fund's JavaScript step).
  send  places queued orders as DAY limit orders (runs after it).

Credentials come from environment variables read by Tiger's SDK (tigeropen): TIGEROPEN_TIGER_ID,
TIGEROPEN_PRIVATE_KEY, TIGEROPEN_ACCOUNT and TIGEROPEN_LICENSE (TBSG for Tiger Brokers Singapore).
Which account trades (paper or live) is decided only by TIGEROPEN_ACCOUNT, and a live, real-money
account is refused unless TIGER_LIVE_TRADING=yes is also set.
"""

import json
import os
import sys
from datetime import datetime, timezone

OPEN = ('sent', 'partial')
# Tiger's order statuses (tigeropen.common.consts.OrderStatus values) -> the fund's.
STATUS = {
    'PendingNew': 'sent', 'Initial': 'sent', 'Submitted': 'sent', 'PendingCancel': 'sent',
    'PartiallyFilled': 'partial', 'Filled': 'filled', 'Cancelled': 'cancelled',
    'Inactive': 'rejected', 'Invalid': 'rejected',
}
NOT_CONNECTED = ('Tiger is not connected: add the TIGEROPEN_TIGER_ID, TIGEROPEN_ACCOUNT, TIGEROPEN_PRIVATE_KEY '
                 'and TIGEROPEN_LICENSE secrets to the GitHub repo (see README).')
LIVE_BLOCKED = ('This is a live, real-money Tiger account. Orders are blocked until the repository variable '
                'TIGER_LIVE_TRADING is set to yes.')


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def fee_of(order):
    """What Tiger charged for an order (its itemised charges, or commission + GST), or None if not reported yet."""
    charges = getattr(order, 'charges', None)
    if charges:
        total = sum(float(getattr(c, 'total', 0) or 0) for c in charges)
        if total > 0:
            return round(total, 2)
    commission = getattr(order, 'commission', None)
    if commission:
        return round(float(commission) + float(getattr(order, 'gst', 0) or 0), 2)
    return None


def status_of(order):
    raw = getattr(order.status, 'value', order.status)
    return STATUS.get(str(raw), 'sent')


class Broker:
    """What the fund needs from Tiger. The real one wraps tigeropen; tests pass a fake."""

    def __init__(self, client, account, is_paper):
        self.client, self.account, self.is_paper = client, account, is_paper

    def place_limit(self, symbol, currency, side, qty, limit_price):
        from tigeropen.common.util.contract_utils import stock_contract
        from tigeropen.common.util.order_utils import limit_order
        order = limit_order(account=self.account, contract=stock_contract(symbol=symbol, currency=currency),
                            action='BUY' if side == 'buy' else 'SELL', quantity=qty,
                            limit_price=limit_price, time_in_force='DAY')
        return self.client.place_order(order) or order.id

    def get_order(self, order_id):
        return self.client.get_order(account=self.account, id=order_id, show_charges=True)

    def cancel(self, order_id):
        return self.client.cancel_order(account=self.account, id=order_id)

    def positions(self):
        return [{
            'symbol': p.contract.symbol, 'currency': getattr(p.contract, 'currency', None),
            'qty': p.quantity, 'avgCost': p.average_cost, 'price': p.market_price,
        } for p in (self.client.get_positions(account=self.account) or [])]


def connect():
    """Returns (Broker, None) or (None, reason)."""
    if not (os.environ.get('TIGEROPEN_TIGER_ID') and os.environ.get('TIGEROPEN_ACCOUNT') and os.environ.get('TIGEROPEN_PRIVATE_KEY')):
        return None, NOT_CONNECTED
    try:
        from tigeropen.tiger_open_config import TigerOpenClientConfig
        from tigeropen.trade.trade_client import TradeClient
        config = TigerOpenClientConfig()
        return Broker(TradeClient(config), config.account, bool(config.is_paper)), None
    except Exception as err:  # noqa: BLE001 - reported on the page
        return None, f'Could not connect to Tiger: {err}'


def account_type(broker):
    return 'paper' if broker.is_paper else 'live'


def sync(fund, broker, error=None):
    """Cancels, refreshes open orders and records positions. Changes `fund` in place."""
    snap = {'time': now_iso(), 'accountType': None, 'positions': [], 'error': error}
    if broker is None:
        fund['broker'] = snap
        return
    snap['accountType'] = account_type(broker)
    for o in fund.get('brokerOrders', []):
        if o.get('status') not in OPEN or not o.get('tigerOrderId'):
            continue
        try:
            if o.get('cancelRequested') and not o.get('cancelSent'):
                broker.cancel(o['tigerOrderId'])
                o['cancelSent'] = True
            t = broker.get_order(o['tigerOrderId'])
            filled = int(getattr(t, 'filled', 0) or 0)
            if filled > (o.get('filledQty') or 0):
                o['filledAt'] = now_iso()
            o['filledQty'] = filled
            if getattr(t, 'avg_fill_price', None):
                o['avgFillPrice'] = float(t.avg_fill_price)
            o['status'] = status_of(t)
            fee = fee_of(t)
            if fee is not None:
                o['fee'] = fee
            if o['status'] == 'rejected':
                o['error'] = getattr(t, 'reason', None) or 'Rejected by Tiger.'
        except Exception as err:  # noqa: BLE001
            o['error'] = f'Could not check this order with Tiger: {err}'
    try:
        snap['positions'] = broker.positions()
    except Exception as err:  # noqa: BLE001
        snap['error'] = f'Could not read positions from Tiger: {err}'
    fund['broker'] = snap


def send(fund, broker, error=None, allow_live=False):
    """Places queued orders. Changes `fund` in place."""
    for o in fund.get('brokerOrders', []):
        if o.get('status') != 'queued':
            continue
        if o.get('cancelRequested'):
            o['status'] = 'cancelled'
            continue
        if broker is None:
            o.update(status='failed', error=error or NOT_CONNECTED)
            continue
        if not broker.is_paper and not allow_live:
            o.update(status='failed', error=LIVE_BLOCKED)
            continue
        try:
            o['tigerOrderId'] = broker.place_limit(o['tigerSymbol'], o['currency'], o['side'], int(o['qty']), float(o['limitPrice']))
            o.update(status='sent', sentAt=now_iso(), accountType=account_type(broker))
        except Exception as err:  # noqa: BLE001
            o.update(status='failed', error=f'Tiger refused the order: {err}')


def main():
    mode, path = sys.argv[1], sys.argv[2]
    try:
        with open(path, encoding='utf-8') as f:
            fund = json.load(f)
    except FileNotFoundError:
        return
    if (fund.get('settings') or {}).get('broker') != 'tiger':
        return
    needs_tiger = any(o.get('status') in OPEN + ('queued',) for o in fund.get('brokerOrders', [])) or mode == 'sync'
    broker, error = connect() if needs_tiger else (None, None)
    if mode == 'sync':
        sync(fund, broker, error)
    elif mode == 'send':
        send(fund, broker, error, allow_live=os.environ.get('TIGER_LIVE_TRADING', '').lower() == 'yes')
    else:
        raise SystemExit(f'Unknown mode {mode}')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fund, f)
    counts = {}
    for o in fund.get('brokerOrders', []):
        counts[o['status']] = counts.get(o['status'], 0) + 1
    print(f'Tiger {mode}: account {(fund.get("broker") or {}).get("accountType") or "?"}; orders {counts}; {error or "ok"}')


if __name__ == '__main__':
    main()
