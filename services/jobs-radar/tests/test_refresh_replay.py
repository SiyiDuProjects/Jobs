import asyncio
import pytest
from mcp.server.auth.provider import TokenError
from mcp.shared.auth import OAuthClientInformationFull

from jobs_radar.auth import OwnerOAuth
from jobs_radar.store import Store


def test_loaded_refresh_race_revokes_family_but_wrong_client_does_not(tmp_path):
    async def exercise():
        auth = OwnerOAuth(Store(tmp_path / 'refresh.sqlite'), 'http://localhost')
        clients = [OAuthClientInformationFull(client_id=name, redirect_uris=['http://localhost/callback']) for name in ['owner', 'other']]
        for client in clients:
            await auth.register_client(client)
        with auth.store.connect(True) as c:
            old = auth._issue(c, 'owner', ['jobs:read'])
        loaded = await auth.load_refresh_token(clients[0], old.refresh_token)
        new = await auth.exchange_refresh_token(clients[0], loaded, ['jobs:read'])
        assert await auth.load_refresh_token(clients[1], old.refresh_token) is None
        assert await auth.load_access_token(new.access_token) is not None
        with pytest.raises(TokenError):
            await auth.exchange_refresh_token(clients[0], loaded, ['jobs:read'])
        assert await auth.load_access_token(new.access_token) is None
        assert await auth.load_refresh_token(clients[0], new.refresh_token) is None
    asyncio.run(exercise())
