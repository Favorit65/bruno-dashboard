import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from activity_stats import ActivityStats, event_time, window_kind
from function_stats import FunctionStats
import model_v2


class ActivityTests(unittest.TestCase):
    def test_window_uses_planned_start_not_early_activation(self):
        rec = {'date':'2026-10-01T08:00:00Z', 'activationDate':'2026-10-01T07:00:00Z',
               'deactivationDate':'2026-10-02T08:00:00Z'}
        self.assertEqual(window_kind(rec), 'daily')
        rec['deactivationDate']='2026-10-02T08:00:01Z'
        self.assertEqual(window_kind(rec), 'prolonged')
        rec['deactivationDate']=None
        self.assertEqual(window_kind(rec), 'unknown')

    def test_actual_date_moves_between_weeks_and_uses_moscow(self):
        rec={'status':'COMPLETED','date_complete':'2026-10-25T22:15:00Z',
             'completionDate':'2026-10-01T08:10:00Z','dateLocal':202610011100}
        self.assertEqual(event_time(rec,'2026-10-01'),('2026-10-26','01'))
        del rec['date_complete']
        self.assertIsNone(event_time(rec,'2026-10-01'))
        rec['status']='WAITING'
        self.assertEqual(event_time(rec,'2026-10-01'),('2026-10-01','11'))

    def test_original_statuses_executor_and_codec(self):
        stats=ActivityStats(FunctionStats({'t':{'name':'Коменданты','memberIDs':['e']}}).attribution)
        rec={'objectID':'o','teamID':'t','zoneID':'z','taskID':'p','employees':['e','f'],
             'date':'2026-10-01T08:00:00Z','dateLocal':2026100111,
             'deactivationDate':'2026-10-31T08:00:00Z','completionDeadlineDate':'2026-10-31T08:10:00Z'}
        for status in ('NEW','WAITING','COMPLETING','MISSED'):
            stats.add({**rec,'status':status},'2026-10-01')
        stats.add({**rec,'status':'COMPLETED','employeeID':'e','date_complete':'2026-10-16T12:00:00Z'},'2026-10-01')
        stats.add({**rec,'status':'COMPLETED','employeeID':'e'},'2026-10-01')
        self.assertEqual(stats.qa['missingActualCompletionDate'],1)
        self.assertEqual(stats.qa['movedCompletions'],1)
        self.assertEqual(sum(sum(v['planned'][k] for k in ('NEW','WAITING','COMPLETING','COMPLETED','MISSED')) for v in stats.rows.values()),5)
        key=next(k for k in stats.rows if k.startswith('2026-10-16'))
        self.assertEqual(stats.rows[key]['planned']['COMPLETED'],1)
        core,cubes=model_v2.encode({'meta':{'buildId':'test'},'daily':{'byActivity':stats.rows}})
        self.assertEqual(core['cubes']['byActivity']['stride'],27)
        self.assertEqual(model_v2.decode(core,cubes)['daily']['byActivity'],stats.rows)


if __name__=='__main__': unittest.main()
