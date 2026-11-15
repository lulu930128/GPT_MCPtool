"""Actual installed adapter and official SDK, isolated from Backend/provider IO."""
import json
import os
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import anyio
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import server
from test_http_server import app_client, TEST_BASE_URL, legacy_initialize, MCP_HEADERS


class TechnicalR1SdkTests(unittest.TestCase):
    def test_exact_legacy_captured_envelope_and_wire_bytes(self):
        async def run():
            path=os.environ.get('OMI_R1_CAPTURED_ENVELOPE')
            expected=json.loads(Path(path).read_text(encoding='utf8')) if path else {
                'contract_version':'omi.decision.v4','ok':True,'evidence':{'data':{'value':0,'missing':None}}}
            with patch.object(server,'_tools_for_client',return_value=server.PUBLIC_TOOLS):
                async with app_client() as http:
                    initialized=await legacy_initialize(http)
                    self.assertEqual(initialized.json()['result']['protocolVersion'],'2025-06-18')
                    headers={**MCP_HEADERS,'MCP-Protocol-Version':'2025-06-18',
                             'Mcp-Session-Id':initialized.headers['Mcp-Session-Id']}
                    await http.post('/mcp',headers=headers,json={'jsonrpc':'2.0','method':'notifications/initialized'})
                    with patch.object(server,'_api_request',return_value=expected):
                        response=await http.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':2,'method':'tools/call',
                            'params':{'name':'omi_ask','arguments':{'question':'Exact captured fixture','refresh_if_missing':False}}})
                    wire=response.json()['result']
                    self.assertEqual(wire['structuredContent'],expected)
                    self.assertEqual(json.loads(wire['content'][0]['text']),expected)
                    self.assertFalse(wire.get('isError',False))
                    print(json.dumps({'case':'R1 exact 2025-06-18','captured_fixture':bool(path),
                                      'canonical_envelope_bytes':len(json.dumps(expected,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()),
                                      'mcp_jsonrpc_wire_bytes':len(response.content),'transport':'isolated ASGI'}))
        anyio.run(run)

    def test_live_and_fallback_schema_keep_backend_scopes(self):
        source = server.PUBLIC_CONTRACT_SNAPSHOT['ask_input_schema']
        expected = source['properties']['selection']['properties']['parameters']['properties']
        catalog = {'tools':[{'name':'omi.ask','input_schema':source}]}
        with patch.object(server, '_api_request',return_value=catalog):
            tools = server._tools_for_client()
        ask=next(t for t in tools if t['name']=='omi_ask')
        actual=ask['inputSchema']['properties']['selection']['properties']['parameters']['properties']
        for name in ['technical.indicators','technical.structure']:
            self.assertEqual(actual[name],expected[name])
        with patch.object(server,'_api_request',side_effect=TimeoutError):
            self.assertEqual(server._tools_for_client(),server.PUBLIC_TOOLS)
        research=next(t for t in tools if t['name']=='omi_read_tw_stock_research')
        self.assertIn('technical',research['inputSchema']['properties']['projection']['pattern'])
        self.assertIn('not an omi.ask shortcut',research['description'])

    def test_both_protocols_forward_exact_scopes_and_mirror_business_results(self):
        async def run():
            for mode in ['2026-07-28','legacy']:
                with patch.object(server,'_tools_for_client',return_value=server.PUBLIC_TOOLS):
                    async with app_client() as http:
                        async with Client(streamable_http_client(f'{TEST_BASE_URL}/mcp',http_client=http),mode=mode) as client:
                            scope={'intervals':['1d'],'indicators':['rsi','atr_dmi_adx'], 'view':'snapshot',
                                   'calculation_limit':1800,'calculation_from':'2020-01-01T00:00:00+08:00',
                                   'calculation_to':'2026-11-11T23:30:00+08:00','analysis_anchor':'2026-11-11',
                                   'price_view':'analysis','include_partial':False}
                            ask={'question':'Exact scope fixture','target':{'type':'tw_stock','id':'2330'},
                                 'selection':{'include':['technical.indicators'],'parameters':{'technical.indicators':scope}},
                                 'realtime_policy':'cache_only','refresh_if_missing':False}
                            expected={'contract_version':'omi.decision.v4','ok':False,'request_status':'rejected',
                                      'error':{'code':'TECHNICAL_VERSION_CONFLICT','stage':'technical_read','retryable':False}}
                            with patch.object(server,'_api_request',return_value=expected) as send:
                                result=await client.call_tool('omi_ask',ask)
                            self.assertFalse(result.is_error)
                            self.assertEqual(result.structured_content,expected)
                            self.assertEqual(json.loads(result.content[0].text),expected)
                            payload=send.call_args.args[2] if len(send.call_args.args)>2 else send.call_args.kwargs.get('payload')
                            self.assertEqual(payload['selection'],ask['selection'])
                            for flag in ['allow_external_fetch','allow_write','allow_llm']:
                                self.assertFalse(payload[flag])
                            for view in ['snapshot','series','detail']:
                                arguments={**{k:v for k,v in scope.items() if k!='intervals'},'indicators':'rsi,atr_dmi_adx',
                                           'stock_id':'2330','projection':'technical','view':view,'sections':'methods,input_quality',
                                           'page_size':7,'expected_read_revision':'a'*64}
                                expected={'kind':'omi.tw_stock_research','version':'omi.tw_stock_research.technical.v2',
                                          'projection':'technical','stock_id':'2330','timeframe':'daily','cache_only':True,
                                          'max_bytes':65536,'technical':{'read_page':{'revision':'a'*64,'items':[]}},
                                          'technical_summary':{},'warnings':[],'limitations':[]}
                                with patch.object(server,'_api_request',return_value=expected) as send:
                                    result=await client.call_tool('omi_read_tw_stock_research',arguments)
                                self.assertFalse(result.is_error)
                                self.assertEqual(result.structured_content,expected)
                                self.assertEqual(json.loads(result.content[0].text),expected)
                                self.assertEqual(send.call_args.args[0],'GET')
                                query=parse_qs(urlsplit(send.call_args.args[1]).query)
                                self.assertEqual(query['calculation_to'],[scope['calculation_to']])
                                self.assertEqual(query['include_partial'],['false'])
                                self.assertEqual(query['view'],[view])
                            with patch.object(server,'_api_request',side_effect=AssertionError('unknown input reached Backend')):
                                result=await client.call_tool('omi_read_tw_stock_research',{'stock_id':'2330','unrecognized_scope':True})
                            self.assertTrue(result.is_error)
        anyio.run(run)
