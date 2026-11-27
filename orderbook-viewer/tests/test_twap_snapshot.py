import copy,unittest
from tests.test_cache import book
from cache import validate_snapshot
class TwapSnapshot(unittest.TestCase):
    def fixture(self):
        value=book();row={'id':'parent','block':value['block'],'block_hash':value['block_hash'],'remaining_parts':3,'normalized_price':'2','slice_base_atoms':'100','remaining_base_atoms':'300','slice_quote_atoms':'200','remaining_quote_atoms':'600','volume_kind':'Scheduled at signed limit, not funded executable depth'}
        value['pairs'][0]['twap_schedules']=[row];return value
    def test_overlay_does_not_change_funded_counts_or_curves(self):
        value=self.fixture();self.assertIs(validate_snapshot(value),value)
        self.assertEqual(value['pairs'][0]['modes']['enriched']['normalized_orders'],[])
        self.assertEqual(value['pairs'][0]['modes']['enriched']['funding_groups'],[])
    def test_bad_pin_and_inconsistent_volume_cannot_publish(self):
        for field,bad in [('block',101),('remaining_base_atoms','301'),('remaining_quote_atoms','601'),('normalized_price','NaN')]:
            value=self.fixture();value['pairs'][0]['twap_schedules'][0][field]=bad
            with self.subTest(field=field),self.assertRaises(AssertionError):validate_snapshot(value)
        value=self.fixture();value['pairs'][0]['twap_schedules']*=2
        with self.assertRaises(AssertionError):validate_snapshot(value)
