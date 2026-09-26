"""Sends the AI fund's orders to Tiger Brokers and brings back what happened to them.

Usage: python scripts/tiger_broker.py sync|send <ai-fund.json>
       python scripts/tiger_broker.py check
  sync  cancels orders the fund asked to cancel, refreshes the status and fills of open orders,
        and records the account's positions (runs before the fund's JavaScript step).
  send  places queued orders (runs after it): DAY limit orders, and standing (GTC) stop orders for the
        fund's stop-losses. Cancellations the fund asked for go first, and a closing order waits until
        any other closing order for the same stock is gone, so the same shares are never sold twice.
  check only reads: connects, and prints the account type, cash and number of positions. No orders.

Credentials come from environment variables read by Tiger's SDK (tigeropen): TIGEROPEN_TIGER_ID,
TIGEROPEN_PRIVATE_KEY, TIGEROPEN_ACCOUNT and TIGEROPEN_LICENSE (TBSG for Tiger Brokers Singapore).
Which account trades (paper or live) is decided only by TIGEROPEN_ACCOUNT, and a live, real-money
account is refused unless TIGER_LIVE_TRADING=yes is also set.
"""

import json
import os
import re
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

    def place_stop(self, symbol, currency, side, qty, stop_price):
        from tigeropen.common.util.contract_utils import stock_contract
        from tigeropen.common.util.order_utils import stop_order
        order = stop_order(account=self.account, contract=stock_contract(symbol=symbol, currency=currency),
                           action='BUY' if side == 'buy' else 'SELL', quantity=qty,
                           aux_price=stop_price, time_in_force='GTC')
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


def clean_key(key):
    """The private key as Tiger's SDK wants it: the bare base64 text, whatever way it was pasted
    (with or without the -----BEGIN/END ... PRIVATE KEY----- lines, line breaks or spaces)."""
    return ''.join(re.sub(r'-----(BEGIN|END)[A-Z ]*-----', '', key).split())


def connect():
    """Returns (Broker, None) or (None, reason)."""
    if not (os.environ.get('TIGEROPEN_TIGER_ID') and os.environ.get('TIGEROPEN_ACCOUNT') and os.environ.get('TIGEROPEN_PRIVATE_KEY')):
        return None, NOT_CONNECTED
    os.environ['TIGEROPEN_PRIVATE_KEY'] = clean_key(os.environ['TIGEROPEN_PRIVATE_KEY'])
    for name in ('TIGEROPEN_TIGER_ID', 'TIGEROPEN_ACCOUNT', 'TIGEROPEN_LICENSE'):  # stray spaces from pasting
        if name in os.environ:
            os.environ[name] = os.environ[name].strip()
    try:
        from tigeropen.tiger_open_config import TigerOpenClientConfig
        from tigeropen.trade.trade_client import TradeClient
        config = TigerOpenClientConfig()
        return Broker(TradeClient(config), config.account, bool(config.is_paper)), None
    except Exception as err:  # noqa: BLE001 - reported on the page
        return None, f'Could not connect to Tiger: {err}'


def account_type(broker):
    return 'paper' if broker.is_paper else 'live'


def refresh(o, broker):
    """Sends a requested cancel (once) and brings the order's status, fills and fee up to date."""
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
            refresh(o, broker)
        except Exception as err:  # noqa: BLE001
            o['error'] = f'Could not check this order with Tiger: {err}'
    try:
        snap['positions'] = broker.positions()
    except Exception as err:  # noqa: BLE001
        snap['error'] = f'Could not read positions from Tiger: {err}'
    fund['broker'] = snap


def closing(o):
    return o.get('action') in ('sell', 'cover')


def clear_way(fund, broker, o):
    """Before a closing order is placed: other closing orders for the same stock that are live at Tiger.
    Stop orders ("guards") among them are cancelled now; anything else must finish first.
    Returns None to go ahead, 'wait' to try next run, or 'skip' if an earlier order already sold."""
    others = [c for c in fund.get('brokerOrders', []) if c is not o and c.get('symbol') == o.get('symbol')
              and closing(c) and c.get('status') in OPEN and c.get('tigerOrderId')]
    for c in others:
        if c.get('source') == 'guard' or c.get('cancelRequested'):
            c['cancelRequested'] = True
            try:
                refresh(c, broker)
            except Exception as err:  # noqa: BLE001
                c['error'] = f'Could not cancel this order with Tiger: {err}'
    if any((c.get('filledQty') or 0) > (c.get('appliedQty') or 0) for c in others):
        return 'skip'
    return 'wait' if any(c.get('status') in OPEN for c in others) else None


def send(fund, broker, error=None, allow_live=False):
    """Places queued orders. Changes `fund` in place."""
    if broker is not None:  # cancellations the fund asked for go before anything new
        for o in fund.get('brokerOrders', []):
            if o.get('cancelRequested') and o.get('status') in OPEN and o.get('tigerOrderId'):
                try:
                    refresh(o, broker)
                except Exception as err:  # noqa: BLE001
                    o['error'] = f'Could not cancel this order with Tiger: {err}'
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
        if closing(o):
            way = clear_way(fund, broker, o)
            if way == 'skip':
                o.update(status='cancelled', error='Not sent: another order for these shares filled first.')
                continue
            if way == 'wait':
                o['note'] = 'Waiting for an earlier order for this stock to finish at Tiger.'
                continue
        try:
            if o.get('type') == 'stop':
                o['tigerOrderId'] = broker.place_stop(o['tigerSymbol'], o['currency'], o['side'], int(o['qty']), float(o['stopPrice']))
            else:
                o['tigerOrderId'] = broker.place_limit(o['tigerSymbol'], o['currency'], o['side'], int(o['qty']), float(o['limitPrice']))
            o.pop('note', None)
            o.update(status='sent', sentAt=now_iso(), accountType=account_type(broker))
        except Exception as err:  # noqa: BLE001
            o.update(status='failed', error=f'Tiger refused the order: {err}')


def check():
    """Read-only connection test. Prints nothing secret: the account number is masked."""
    broker, error = connect()
    if broker is None:
        raise SystemExit(error)
    account = str(broker.account)
    print(f'Connected to Tiger: {account_type(broker)} account ending {account[-4:]}, license {os.environ.get("TIGEROPEN_LICENSE")}')
    if not broker.is_paper:  # Actions logs of a public repo are public: no real balances or holdings
        if os.environ.get('TIGER_LIVE_TRADING', '').lower() != 'yes':
            print('  Live account: orders stay blocked until the TIGER_LIVE_TRADING variable is yes.')
        return
    try:
        assets = broker.client.get_prime_assets(account=broker.account)
        for name, seg in (getattr(assets, 'segments', None) or {}).items():
            print(f'  segment {name}: cash {seg.cash_balance:,.2f} {seg.currency}, net value {seg.net_liquidation:,.2f}, buying power {seg.buying_power:,.2f}')
    except Exception as err:  # noqa: BLE001 - only informative
        print(f'  (could not read balances: {err})')
    positions = broker.positions()
    print(f'  {len(positions)} open positions')


def tiger_funds(data):
    """The funds trading through Tiger: a file holds several funds ({"funds": [...]}, see funds.js),
    or one fund in files from before that."""
    funds = data.get('funds') if isinstance(data.get('funds'), list) else [data]
    return [f for f in funds if (f.get('settings') or {}).get('broker') == 'tiger' and 'portfolio' in f]


def main():
    if sys.argv[1] == 'check':
        check()
        return
    mode, path = sys.argv[1], sys.argv[2]
    if mode not in ('sync', 'send'):
        raise SystemExit(f'Unknown mode {mode}')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return
    funds = tiger_funds(data)
    if not funds:
        return
    busy = any(o.get('status') in OPEN + ('queued',) for fund in funds for o in fund.get('brokerOrders', []))
    broker, error = connect() if busy or mode == 'sync' else (None, None)
    counts = {}
    for fund in funds:  # all Tiger funds share the one account; each only touches its own orders
        if mode == 'sync':
            sync(fund, broker, error)
        else:
            send(fund, broker, error, allow_live=os.environ.get('TIGER_LIVE_TRADING', '').lower() == 'yes')
        for o in fund.get('brokerOrders', []):
            counts[o['status']] = counts.get(o['status'], 0) + 1
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    account = broker and account_type(broker)
    print(f'Tiger {mode}: {len(funds)} fund(s), account {account or "?"}; orders {counts}; {error or "ok"}')


if __name__ == '__main__':
    main()
