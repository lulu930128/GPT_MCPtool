"""Print the discovered MCP transport bindings, including unlisted compatibility aliases."""
import json

from server import _tools_for_client, public_inventory


if __name__ == "__main__":
    print(json.dumps(public_inventory(_tools_for_client()), indent=2, ensure_ascii=False))
