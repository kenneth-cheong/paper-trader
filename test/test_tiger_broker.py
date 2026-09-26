"""Tests for scripts/tiger_broker.py with a fake Tiger account. Run: python -m unittest discover -s test -p 'test_*.py'"""

import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import tiger_broker as tb  # noqa: E402


class FakeBroker:
    def __init__(self, is_paper=True, orders=None, fail_place=None):
        self.is_paper = is_paper
        self.placed, self.cancelled = [], []
        self.orders = orders or {}
        self.fail_place = fail_place

    def place_limit(self, symbol, currency, side, qty, limit_price):
        if self.fail_place:
            raise RuntimeError(self.fail_place)
        self.placed.append((symbol, currency, side, qty, limit_price))
        return 9000 + len(self.placed)

    def get_order(self, order_id):
        return self.orders[order_id]

    def cancel(self, order_id):
        self.cancelled.append(order_id)

    def positions(self):
        return [{'symbol': 'AAPL', 'currency': 'USD', 'qty': 10, 'avgCost': 100.0, 'price': 101.0}]


def order(**kw):
    base = {'id': 'b1', 'symbol': 'AAPL', 'tigerSymbol': 'AAPL', 'currency': 'USD', 'side': 'buy', 'qty': 10,
            'limitPrice': 101.0, 'status': 'queued', 'filledQty': 0, 'appliedQty': 0}
    base.update(kw)
    return base


def tiger_order(status, filled=0, price=None, reason=None, commission=None, gst=None, charges=None):
    return SimpleNamespace(status=SimpleNamespace(value=status), filled=filled, avg_fill_price=price, reason=reason,
                           commission=commission, gst=gst, charges=charges)


class SendTests(unittest.TestCase):
    def test_places_queued_limit_orders(self):
        fund = {'brokerOrders': [order(), order(id='b2', status='sent')]}
        b = FakeBroker()
        tb.send(fund, b)
        self.assertEqual(b.placed, [('AAPL', 'USD', 'buy', 10, 101.0)])
        self.assertEqual(fund['brokerOrders'][0]['status'], 'sent')
        self.assertEqual(fund['brokerOrders'][0]['tigerOrderId'], 9001)
        self.assertEqual(fund['brokerOrders'][0]['accountType'], 'paper')

    def test_live_account_is_blocked_unless_allowed(self):
        fund = {'brokerOrders': [order()]}
        b = FakeBroker(is_paper=False)
        tb.send(fund, b)
        self.assertEqual(b.placed, [])
        self.assertEqual(fund['brokerOrders'][0]['status'], 'failed')
        self.assertIn('TIGER_LIVE_TRADING', fund['brokerOrders'][0]['error'])
        fund = {'brokerOrders': [order()]}
        tb.send(fund, b, allow_live=True)
        self.assertEqual(fund['brokerOrders'][0]['status'], 'sent')

    def test_not_connected_and_refused_orders_fail_with_a_reason(self):
        fund = {'brokerOrders': [order()]}
        tb.send(fund, None, tb.NOT_CONNECTED)
        self.assertEqual(fund['brokerOrders'][0]['status'], 'failed')
        self.assertIn('TIGEROPEN_TIGER_ID', fund['brokerOrders'][0]['error'])
        fund = {'brokerOrders': [order()]}
        tb.send(fund, FakeBroker(fail_place='insufficient buying power'))
        self.assertIn('insufficient buying power', fund['brokerOrders'][0]['error'])

    def test_cancelled_before_sending(self):
        fund = {'brokerOrders': [order(cancelRequested=True)]}
        b = FakeBroker()
        tb.send(fund, b)
        self.assertEqual(b.placed, [])
        self.assertEqual(fund['brokerOrders'][0]['status'], 'cancelled')


class FeeTests(unittest.TestCase):
    def test_itemised_charges_win_over_commission(self):
        order = tiger_order('Filled', commission=1.99, gst=0.18, charges=[SimpleNamespace(total=1.99), SimpleNamespace(total=0.21)])
        self.assertEqual(tb.fee_of(order), 2.2)
        self.assertIsNone(tb.fee_of(tiger_order('Filled')))


try:
    from tigeropen.common.util.signature_utils import load_private_key
except ImportError:  # the SDK is only installed where Tiger is used
    load_private_key = None


class KeyTests(unittest.TestCase):
    BARE = 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu'

    def test_private_key_is_cleaned_however_it_was_pasted(self):
        pem = f'-----BEGIN RSA PRIVATE KEY-----\n{self.BARE[:30]}\n{self.BARE[30:]}\n-----END RSA PRIVATE KEY-----\n'
        for pasted in (pem, '  ' + pem.replace('\n', '\r\n'), pem.replace('RSA PRIVATE', 'PRIVATE'), self.BARE):
            self.assertEqual(tb.clean_key(pasted), self.BARE)

    @unittest.skipUnless(load_private_key, 'tigeropen not installed')
    def test_tiger_sdk_accepts_the_cleaned_key(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        for fmt in (serialization.PrivateFormat.TraditionalOpenSSL, serialization.PrivateFormat.PKCS8):
            pem = key.private_bytes(serialization.Encoding.PEM, fmt, serialization.NoEncryption()).decode()
            cleaned = tb.clean_key(pem.replace('\n', '\r\n'))
            self.assertEqual(load_private_key(cleaned).private_numbers(), key.private_numbers())


class SyncTests(unittest.TestCase):
    def test_brings_back_fills_rejections_and_positions(self):
        fund = {'brokerOrders': [
            order(id='b1', status='sent', tigerOrderId=1),
            order(id='b2', status='sent', tigerOrderId=2),
            order(id='b3', status='partial', tigerOrderId=3, filledQty=2),
            order(id='b4', status='filled', tigerOrderId=4, filledQty=10),
        ]}
        b = FakeBroker(orders={
            1: tiger_order('Filled', 10, 100.4, commission=1.99, gst=0.18),
            2: tiger_order('Inactive', reason='Not enough buying power'),
            3: tiger_order('PartiallyFilled', 6, 100.1),
        })
        tb.sync(fund, b)
        o1, o2, o3, o4 = fund['brokerOrders']
        self.assertEqual((o1['status'], o1['filledQty'], o1['avgFillPrice']), ('filled', 10, 100.4))
        self.assertIn('filledAt', o1)
        self.assertEqual(o1['fee'], 2.17)  # commission + GST as Tiger reported them
        self.assertNotIn('fee', o3)  # not reported yet
        self.assertEqual((o2['status'], o2['error']), ('rejected', 'Not enough buying power'))
        self.assertEqual((o3['status'], o3['filledQty']), ('partial', 6))
        self.assertEqual(o4['status'], 'filled')  # finished orders aren't asked about again
        self.assertEqual(fund['broker']['accountType'], 'paper')
        self.assertEqual(fund['broker']['positions'][0]['symbol'], 'AAPL')

    def test_cancels_what_the_fund_asked_to_cancel_once(self):
        fund = {'brokerOrders': [order(status='sent', tigerOrderId=7, cancelRequested=True)]}
        b = FakeBroker(orders={7: tiger_order('Cancelled')})
        tb.sync(fund, b)
        tb.sync(fund, b)
        self.assertEqual(b.cancelled, [7])
        self.assertEqual(fund['brokerOrders'][0]['status'], 'cancelled')

    def test_not_connected_is_reported(self):
        fund = {'brokerOrders': []}
        tb.sync(fund, None, tb.NOT_CONNECTED)
        self.assertIn('not connected', fund['broker']['error'])


if __name__ == '__main__':
    unittest.main()
