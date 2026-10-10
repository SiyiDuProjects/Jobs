"""Shared wire format for both answer engines; no semantic proof gates."""
import copy


def result(field, profile_id, version, kind='unknown', value=None, **metadata):
    return {
        'fieldId': field['fieldId'], 'kind': kind, 'value': value,
        'questionZh': '', 'answerZh': '', 'reasonZh': '缺少作答所需的信息',
        **metadata,
        'binding': {'profileId': profile_id, 'profileVersion': version,
                    'field': copy.deepcopy(field)},
    }


def from_legacy(row, field, profile_id, version):
    kind = ('draft' if row.get('decision') == 'draft' else 'answer') if row.get('state') == 'answer' else 'unknown'
    return result(field, profile_id, version, kind, row.get('value') if kind != 'unknown' else None,
                  questionZh=row.get('questionZh', ''), answerZh=row.get('answerZh', ''),
                  reasonZh=row.get('reason', ''), interruptionReason=row.get('interruptionReason', ''),
                  jobSpecific=True, source=row.get('source', 'unknown'))
