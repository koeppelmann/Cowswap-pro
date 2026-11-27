"""Independent cases from canonical TWAPOrderMathLib's inclusive validity windows."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from twap import schedule_state


class TwapScheduleAcceptance(unittest.TestCase):
    def schedule(self,**changes):
        return {'part_sell_atoms':'100','min_buy_atoms':'200','total_parts':4,
                'interval_seconds':60,'span_seconds':0,'start_time':1000,**changes}

    def assert_amounts(self,state,parts,sell,buy):
        self.assertEqual(state['remaining_parts'],parts)
        self.assertEqual(str(state['remaining_sell_atoms']),sell)
        self.assertEqual(str(state['remaining_min_buy_atoms']),buy)

    def test_before_start_keeps_all_future_parts_without_a_current_child(self):
        state=schedule_state(self.schedule(),999)
        self.assert_amounts(state,4,'400','800')
        self.assertIsNone(state['current_index'])
        self.assertEqual(state['next_slice_at'],1000)

    def test_full_period_boundaries_and_missed_past_windows(self):
        cases=[(1000,4,0,1059),(1059,4,0,1059),(1060,3,1,1119),
               (1121,2,2,1179),(1180,1,3,1239),(1239,1,3,1239)]
        amounts={4:('400','800'),3:('300','600'),2:('200','400'),1:('100','200')}
        for now,parts,index,valid_to in cases:
            with self.subTest(now=now):
                state=schedule_state(self.schedule(),now)
                self.assert_amounts(state,parts,*amounts[parts])
                self.assertEqual(state['current_index'],index)
                self.assertEqual(state['current_valid_to'],valid_to)
        expired=schedule_state(self.schedule(),1240)
        self.assert_amounts(expired,0,'0','0')
        self.assertIsNone(expired['next_slice_at'])

    def test_filled_fok_current_child_does_not_remove_future_slices(self):
        for filled in [1,100,2**256-1]:
            with self.subTest(filled=filled):
                state=schedule_state(self.schedule(),1005,current_filled_atoms=filled)
                self.assert_amounts(state,3,'300','600')
                self.assertEqual(state['next_slice_at'],1060)
        state=schedule_state(self.schedule(),1060,current_filled_atoms=100)
        self.assert_amounts(state,2,'200','400')
        self.assertEqual(state['next_slice_at'],1120)

    def test_short_span_gap_excludes_the_expired_current_window(self):
        schedule=self.schedule(span_seconds=20)
        current=schedule_state(schedule,1019)
        self.assert_amounts(current,4,'400','800')
        self.assertEqual(current['current_valid_to'],1019)
        gap=schedule_state(schedule,1020)
        self.assert_amounts(gap,3,'300','600')
        self.assertEqual(gap['next_slice_at'],1060)
        missed=schedule_state(schedule,1140)
        self.assert_amounts(missed,1,'100','200')
        self.assertEqual(missed['next_slice_at'],1180)

    def test_final_span_end_has_no_remaining_volume_even_before_nominal_end(self):
        schedule=self.schedule(span_seconds=20)
        self.assert_amounts(schedule_state(schedule,1199),1,'100','200')
        state=schedule_state(schedule,1200)
        self.assert_amounts(state,0,'0','0')
        self.assertIsNone(state['next_slice_at'])

    def test_cancelled_parent_never_contributes_future_volume(self):
        for now in [999,1000,1100]:
            with self.subTest(now=now):
                state=schedule_state(self.schedule(),now,authorized=False)
                self.assert_amounts(state,0,'0','0')
                self.assertIsNone(state['next_slice_at'])

    def test_missing_start_context_is_unknown_not_a_fabricated_volume(self):
        schedule=self.schedule(start_time=0)
        unknown=schedule_state(schedule,1005)
        self.assertFalse(unknown['state_complete'])
        self.assertIsNone(unknown['remaining_parts'])
        resolved=schedule_state(schedule,1005,effective_start=1000)
        self.assert_amounts(resolved,4,'400','800')
        known_zero=schedule_state(schedule,1005,effective_start=0)
        self.assert_amounts(known_zero,0,'0','0')

    def test_large_atom_amounts_stay_exact_beyond_float_precision(self):
        schedule=self.schedule(part_sell_atoms='340282366920938463463374607431768211457',
                               min_buy_atoms='340282366920938463463374607431768211459')
        state=schedule_state(schedule,1060)
        self.assert_amounts(state,3,'1020847100762815390390123822295304634371',
                            '1020847100762815390390123822295304634377')


if __name__=='__main__':unittest.main()
