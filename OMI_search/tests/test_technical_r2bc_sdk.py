"""R2 B/C generated schema and isolated official-SDK transport checks."""
import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import anyio
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import server
from test_http_server import app_client, TEST_BASE_URL, legacy_initialize, MCP_HEADERS


METHODS = ['keltner', 'supertrend', 'williams_r', 'squeeze']
EXPECTED = {
    'kind': 'omi.tw_stock_research', 'version': 'omi.tw_stock_research.technical.v2',
    'projection': 'technical', 'stock_id': '2330', 'timeframe': 'daily', 'cache_only': True,
    'max_bytes': 65536, 'technical': {
        'keltner': {'upper': 103, 'middle': 100, 'lower': 97},
        'supertrend': {'value': 97, 'direction': 1}, 'williams_r': {'williams_r14': -100},
        'squeeze': {'state': 'on', 'released': False, 'momentum': 0, 'direction': 'neutral', 'momentum_change': None},
        'method_quality': {'squeeze': {'research_usable': False, 'reason_codes': ['FIXTURE_PARTIAL']}},
    }, 'technical_summary': {}, 'warnings': ['FIXTURE_PARTIAL'], 'limitations': [],
}


class TechnicalR2BCSdkTests(unittest.TestCase):
    def test_current_sdk_generated_scopes_and_exact_payloads(self):
        schema = server.PUBLIC_CONTRACT_SNAPSHOT['ask_input_schema']
        methods = schema['properties']['selection']['properties']['parameters']['properties']['technical.indicators']['properties']['indicators']['items']['enum']
        self.assertTrue(set(METHODS) <= set(methods))

        async def run():
            with patch.object(server, '_tools_for_client', return_value=server.PUBLIC_TOOLS):
                async with app_client() as http:
                    async with Client(streamable_http_client(f'{TEST_BASE_URL}/mcp', http_client=http), mode='2026-07-28') as client:
                        for view in ('snapshot', 'series', 'detail'):
                            args = dict(stock_id='2330', projection='technical', indicators=','.join(METHODS), view=view, include_partial=False)
                            with patch.object(server, '_api_request', return_value=EXPECTED) as send:
                                result = await client.call_tool('omi_read_tw_stock_research', args)
                            self.assertFalse(result.is_error)
                            self.assertEqual(result.structured_content, EXPECTED)
                            self.assertEqual(json.loads(result.content[0].text), EXPECTED)
                            self.assertEqual(parse_qs(urlsplit(send.call_args.args[1]).query)['indicators'], [','.join(METHODS)])
                        ask = dict(question='R2 B/C fixture', target={'type':'tw_stock','id':'2330'},
                            selection={'include':['technical.indicators'], 'parameters':{'technical.indicators':{
                                'intervals':['1d'], 'indicators':METHODS, 'view':'snapshot'}}},
                            refresh_if_missing=False, realtime_policy='cache_only')
                        expected = {'contract_version':'omi.decision.v4', 'ok':True, 'evidence':{'data':EXPECTED['technical']}}
                        with patch.object(server, '_api_request', return_value=expected) as send:
                            result = await client.call_tool('omi_ask', ask)
                        self.assertEqual(result.structured_content, expected)
                        payload = send.call_args.args[2] if len(send.call_args.args) > 2 else send.call_args.kwargs['payload']
                        self.assertEqual(payload['selection'], ask['selection'])
                        self.assertFalse(payload['allow_external_fetch'])
                        self.assertFalse(payload['allow_write'])
        anyio.run(run)

    def test_exact_2025_06_18_handshake_preserves_new_states(self):
        async def run():
            with patch.object(server, '_tools_for_client', return_value=server.PUBLIC_TOOLS):
                async with app_client() as http:
                    initialized = await legacy_initialize(http)
                    self.assertEqual(initialized.json()['result']['protocolVersion'], '2025-06-18')
                    headers = {**MCP_HEADERS, 'MCP-Protocol-Version':'2025-06-18',
                        'Mcp-Session-Id':initialized.headers['Mcp-Session-Id']}
                    await http.post('/mcp', headers=headers, json={'jsonrpc':'2.0','method':'notifications/initialized'})
                    with patch.object(server, '_api_request', return_value=EXPECTED):
                        response = await http.post('/mcp', headers=headers, json={'jsonrpc':'2.0','id':2,'method':'tools/call',
                            'params':{'name':'omi_read_tw_stock_research','arguments':{
                                'stock_id':'2330','projection':'technical','indicators':','.join(METHODS)}}})
                    result = response.json()['result']
                    self.assertFalse(result.get('isError', False))
                    self.assertEqual(result['structuredContent'], EXPECTED)
                    self.assertEqual(json.loads(result['content'][0]['text']), EXPECTED)
        anyio.run(run)
