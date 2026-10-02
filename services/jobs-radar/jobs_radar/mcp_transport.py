"""The service's MCP transport settings, shared by production and integration tests."""
from urllib.parse import urlsplit

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.server.mcpserver.exceptions import ToolError

from .maintenance import ReleaseMaintenance


class ToolPermissionError(PermissionError, ToolError):
    """Expected authorization refusal; expose only our fixed, nonprivate message."""


class JobsMCPServer(MCPServer):
    def __init__(self, *args, origin, **kwargs):
        super().__init__(*args, **kwargs)
        self.origin = origin

    def streamable_http_app(self, **kwargs):
        app = super().streamable_http_app(
            stateless_http=True, json_response=True,
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
                allowed_hosts=[urlsplit(self.origin).netloc, '127.0.0.1:*', 'localhost:*'],
                allowed_origins=[self.origin]), **kwargs)
        app.add_middleware(ReleaseMaintenance)
        return app
