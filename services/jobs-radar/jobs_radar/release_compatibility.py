"""Stored-data format identity, independent of retired migration implementations."""
APPLICATIONS = 'applications-v2'
PROFILE = 1
DIAGNOSTICS = 'diagnostics-v2-2026-09-26'
SUBMISSIONS = 'native-extension-submission-reporting-v1'


def data_contract():
    return {'applications': APPLICATIONS, 'profile': PROFILE, 'diagnostics': DIAGNOSTICS}
