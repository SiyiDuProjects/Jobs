"""Conservative rollback contract: every stored-data format must match."""
from .application_schema import VERSION as APPLICATIONS
from .profile_contract import VERSION as PROFILE
from .diagnostic_migration import VERSION as DIAGNOSTICS


def data_contract():
    return {'applications': APPLICATIONS, 'profile': PROFILE, 'diagnostics': DIAGNOSTICS}
