from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from feedback_register import FeedbackRegister, PUBLIC_OBJECTS, mask_contacts
import model_v2


class RequestDetailTest(unittest.TestCase):
    def test_request_is_unique_across_tasks_and_redacted_before_serialization(self):
        reg = FeedbackRegister([{'id':'floor','name':'12 этаж'},
                                {'id':'zone','name':'Холл','parentID':'floor'}])
        row = {'id':'t1','feedbackID':'request','objectID':sorted(PUBLIC_OBJECTS)[0],
               'feedback':{'date':'2026-10-10T23:30:00Z','zoneID':'zone','phone':'ignored'},
               'date':'2026-10-11T04:00:00Z','deactivationDate':'2026-10-11T15:00:00Z',
               'date_complete':'2026-10-12T05:00:00Z','employeeID':'employee','status':'COMPLETED'}
        msg = 'Позвонить +7 (999) 123-45-67, написать test@example.org или @tester'
        reg.add(row, 'Функция', msg)
        reg.add(row, 'Функция', msg)
        reg.add({**row,'id':'t2','status':'WAITING'}, 'Функция', msg)
        items = reg.rows()
        self.assertEqual(len(items),1)
        r = items[0]
        self.assertTrue(r['registered'].startswith('2026-10-11T02:30'))
        self.assertEqual((r['floor'],r['zone']),('12 этаж','Холл'))
        self.assertEqual([t['done'] for t in r['tasks']],[True,False])
        self.assertEqual([t['executor'] for t in r['tasks']],['employee',''])
        self.assertEqual(r['text'].count('[контакт скрыт]'),3)
        core,cubes = model_v2.encode({'meta':{},'daily':{},'feedbackRegister':items})
        self.assertEqual(model_v2.decode(core,cubes)['feedbackRegister'],items)
        reg.add({**row, 'isPrivate': True}, 'Функция', msg)
        reg.add(row, 'Функция', msg)
        self.assertEqual(reg.rows()[0]['text'], '[закрытое обращение]')

    def test_links_and_extensions(self):
        self.assertEqual(mask_contacts('t.me/contact доб. 4321'), '[контакт скрыт] [контакт скрыт]')
