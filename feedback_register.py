"""Request-level detail from taskPlan.feedback and the zone hierarchy."""
import re

from activity_stats import MSK, instant, window_kind


PUBLIC_OBJECTS = {
    '2b4ca6a5-47c5-4aab-b66a-e84dc026f22c', '7cbbf23b-a270-4ff0-bdb3-24d79456a0b1',
    'a037facd-77d3-4fd6-b2b9-a33b90ab0eb0', 'a5fc4390-5a9f-4521-8443-9364e0065603',
    'da25b805-5315-484b-8159-82a9c8eeb5af',
}

CONTACT_PATTERNS = [
    r'(?i)\b[\w.%+\-]+@[\w.\-]+\.[\w\-]+',
    r'(?i)(?:https?://|www\.|t\.me/|wa\.me/|telegram\.me/)\S+',
    r'(?<!\w)@[\w.]+',
    r'(?<!\d)\+?\d(?:[\s().–—-]*\d){6,}(?!\d)',
    r'(?i)\b(?:доб(?:авочный)?|вн(?:утренний)?|тел(?:ефон)?)\.?[\s:№-]*\d(?:[ ()-]*\d){2,}',
]


def mask_contacts(text):
    for pattern in CONTACT_PATTERNS:
        text = re.sub(pattern, '[контакт скрыт]', text)
    return text


class FeedbackRegister:
    def __init__(self, zones):
        self.zones = {str(z['id']): z for z in zones if z.get('id')}
        self.requests = {}

    def location(self, zone_id):
        zone = self.zones.get(zone_id, {})
        name = zone.get('name', '')
        seen = set()
        while zone and zone['id'] not in seen:
            seen.add(zone['id'])
            if re.search(r'\bэтаж\w*\b', zone.get('name') or '', re.I):
                return name, zone['name'].strip()
            zone = self.zones.get(zone.get('parentID'))
        return name, ''

    def add(self, rec, role, text):
        if rec.get('objectID') not in PUBLIC_OBJECTS:
            return
        fid = rec['feedbackID']
        fb = rec.get('feedback')
        fb = fb if isinstance(fb, dict) else {}
        if fid not in self.requests:
            zone, floor = self.location(fb.get('zoneID') or rec.get('zoneID'))
            stamp = instant(fb.get('date'))
            self.requests[fid] = {
                'id': fid, 'object': rec.get('objectID'), 'zone': zone, 'floor': floor,
                'registered': stamp.astimezone(MSK).isoformat(timespec='seconds') if stamp else '',
                'text': mask_contacts(text) if not rec.get('isPrivate') else '[закрытое обращение]', 'tasks': {}
            }
        entry = self.requests[fid]
        if rec.get('isPrivate'):
            entry['text'] = '[закрытое обращение]'
        status = rec.get('status') or ''
        executor = rec.get('employeeID') or ''
        done = status == 'COMPLETED' and bool(executor and instant(rec.get('date_complete')))
        entry['tasks'][rec['id']] = {
            'role': role, 'window': window_kind(rec), 'status': status,
            'done': done, 'executor': executor if done else ''
        }

    def rows(self):
        return [{**entry, 'tasks': list(entry['tasks'].values())}
                for entry in self.requests.values()]
