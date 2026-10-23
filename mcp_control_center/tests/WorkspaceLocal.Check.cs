namespace McpCc.WorkspaceLocal {
    public static class Fixture {
        static int checks;
        public static string Diagnostics(Snapshot snapshot,string id) {
            return snapshot.Reply(Request("diagnostics",id,"","",""));
        }
        public static string Status(Snapshot snapshot) {
            return snapshot.Reply(Request("status","","","",""));
        }
        static void Check(bool value) { checks++;if(!value) throw new System.Exception("CHECK_"+checks); }
        static void Reject(System.Action action) { bool rejected=false;try {action();} catch {rejected=true;} Check(rejected); }
        public static Snapshot Sample() {
            var rows=new System.Collections.Generic.List<Row>();
            foreach(string id in Contract.Ids) rows.Add(new Row {componentId=id,status="Ready",observedAt=System.DateTimeOffset.UtcNow.ToString("o"),capabilities=new [] {"reload_runtime"}});
            var row=rows[0];
            return new Snapshot(rows.ToArray(),new [] {new Detail {componentId=row.componentId,status=row.status,localStatus="Ready",observedAt=row.observedAt,readinessScope="local",
                probes=new [] {new ProbeDetail {role="core",success=true,tcpOpen=true,ownerKnown=true,pid=123,matchesExpected=true,runtimeBuildId="abcd1234",activeJobs=1,pendingApproval=0,controller="ready"}}}});
        }
        static System.Collections.Generic.Dictionary<string,string> Request(string op,string id,string action,string requestId,string confirmation) {
            var value=new System.Collections.Generic.Dictionary<string,string> {{"v","1"},{"nonce",new string('a',64)},{"challenge",new string('b',64)},
                {"operation",op},{"componentId",id},{"action",action},{"requestId",requestId},{"confirmation",confirmation}};
            return Contract.Request(Contract.Json().Serialize(value),new string('b',64));
        }
        public static Owner Open(string name,string root) {
            if(!name.StartsWith("mcpcc-local-fixture-",System.StringComparison.Ordinal)) throw new System.Exception("FIXTURE_NAMESPACE_REQUIRED");
            var owner=new Owner(name,root);owner.Publish(Sample());owner.Start();return owner;
        }
        public static void Accept(Owner owner,string requestId,string target) {
            Check(owner.Dispatch(Request("restart",target,"reload_runtime",requestId,"interrupt_current_requests")).Contains("ACTION_ACCEPTED"));
            Check(owner.TakePending().requestId==requestId);
        }
        static System.IO.Pipes.NamedPipeClientStream Client(string name) {
            var client=new System.IO.Pipes.NamedPipeClientStream(".",name,System.IO.Pipes.PipeDirection.InOut,System.IO.Pipes.PipeOptions.Asynchronous);
            try { client.Connect(1000);return client; } catch { client.Dispose();throw; }
        }
        static string Exchange(string name,System.Collections.Generic.Dictionary<string,string> request) {
            using(var client=Client(name)) {
                var clock=System.Diagnostics.Stopwatch.StartNew();
                request["challenge"]=Frame.Read(client,clock);
                Frame.Write(client,Contract.Json().Serialize(request),clock);
                return Frame.Read(client,clock);
            }
        }
        public static int RunRecovery(string root) {
            int before=checks;
            string name="mcpcc-local-fixture-"+System.Guid.NewGuid().ToString("N");
            string key=System.Guid.NewGuid().ToString("D");
            var restart=Request("restart","codex_bridge","reload_runtime",key,"interrupt_current_requests");
            using(var owner=Open(name,root)) {
                Check(Exchange(name,restart).Contains("ACTION_ACCEPTED"));
                Check(owner.TakePending().requestId==key);
                // The active dispatcher must not occupy the IPC listener.
                Check(Exchange(name,Request("status","","","","")).Contains("OWNER_OBSERVATION"));
                owner.Complete(key,"UNKNOWN");
                for(int mode=0;mode<7;mode++) {
                    using(var client=Client(name)) {
                        var clock=System.Diagnostics.Stopwatch.StartNew();
                        if(mode!=0) Frame.Read(client,clock);
                        if(mode==1) client.Write(new byte[] {4,0},0,2); // aborted header
                        if(mode==2) client.Write(new byte[] {10,0,0,0,123},0,5); // aborted body
                        if(mode==3) Frame.Write(client,"{bad}",clock);
                        if(mode==4) client.Write(System.BitConverter.GetBytes(Contract.MaxBytes+1),0,4);
                        if(mode==5) { client.Write(new byte[] {4,0},0,2);System.Threading.Thread.Sleep(Contract.DeadlineMs+150); }
                        if(mode==6) {
                            var request=Request("status","","","","");
                            // Read a fresh challenge above, but intentionally use a wrong one.
                            Frame.Write(client,Contract.Json().Serialize(request),clock);
                        }
                    }
                    for(int i=0;i<3;i++) {
                        Check(Exchange(name,Request("status","","","","")).Contains("OWNER_OBSERVATION"));
                        var receipt=Exchange(name,Request("receipt","","",key,""));
                        Check(receipt.Contains("UNKNOWN") && receipt.Contains("\"completed\":null"));
                    }
                    Check(owner.Running);Reject(()=>new Owner(name,root));
                }
                Check(Exchange(name,restart).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
                var success=Request("restart","omi_search","reload_runtime",System.Guid.NewGuid().ToString("D"),"interrupt_current_requests");
                Check(Exchange(name,success).Contains("ACTION_ACCEPTED"));
                owner.Complete(owner.TakePending().requestId,"COMPLETED");
                Check(Exchange(name,Request("receipt","","",success["requestId"],"")).Contains("COMPLETED"));
                // A client keeping the reply socket open must time out and settle its
                // pending drain read before the very same server handle is reused.
                using(var client=Client(name)) {
                    var clock=System.Diagnostics.Stopwatch.StartNew();var request=Request("status","","","","");
                    request["challenge"]=Frame.Read(client,clock);Frame.Write(client,Contract.Json().Serialize(request),clock);
                    Check(Frame.Read(client,clock).Contains("OWNER_OBSERVATION"));
                    System.Threading.Thread.Sleep(Contract.DeadlineMs+150);
                    Check(Exchange(name,Request("status","","","","")).Contains("OWNER_OBSERVATION"));
                }
            }
            // Disposal during accept and during a pending read is bounded and quiet.
            var idle=Open(name,root);var watch=System.Diagnostics.Stopwatch.StartNew();idle.Dispose();
            Check(watch.ElapsedMilliseconds<Contract.DeadlineMs+500);
            var reading=Open(name,root);
            using(var client=Client(name)) {
                Frame.Read(client,System.Diagnostics.Stopwatch.StartNew());watch.Restart();reading.Dispose();
                Check(watch.ElapsedMilliseconds<Contract.DeadlineMs+500);
            }
            return checks-before;
        }
        public static int RunDiagnostics(string root) {
            int before=checks;
            string name="mcpcc-local-fixture-"+System.Guid.NewGuid().ToString("N");
            foreach(string reason in new [] {"ACTIVE_WORK_PRESENT","OWNERSHIP_MISMATCH","OWNERSHIP_UNKNOWN","ACTIVE_STATE_UNKNOWN"}) {
                string key=System.Guid.NewGuid().ToString("D");
                var request=Request("restart","codex_bridge","reload_runtime",key,"interrupt_current_requests");
                using(var owner=Open(name,root)) {
                    Check(Exchange(name,request).Contains("ACTION_ACCEPTED"));
                    Reject(()=>owner.CompleteRefusal(key,reason)); // not dispatched yet
                    Check(owner.TakePending().requestId==key);
                    Reject(()=>owner.CompleteRefusal(System.Guid.NewGuid().ToString("D"),reason));
                    Reject(()=>owner.CompleteRefusal(key,"CONTROLLER_TIMEOUT"));
                    Reject(()=>owner.CompleteRefusal(key,"ACTIVE_WORK_PRESENT private-token"));
                    Check(owner.HasActiveRequest);
                    owner.CompleteRefusal(key,reason);Check(!owner.HasActiveRequest);
                    string path=System.IO.Path.Combine(root,"workspace-local-diagnostics",key+".json");
                    var evidence=Contract.Json().DeserializeObject(System.IO.File.ReadAllText(path)) as System.Collections.Generic.Dictionary<string,object>;
                    Check(evidence.Count==5 && (string)evidence["requestId"]==key && (string)evidence["reason"]==reason && (string)evidence["componentId"]=="codex_bridge" && (string)evidence["action"]=="reload_runtime");
                    string wire=Exchange(name,Request("receipt","","",key,""));
                    Check(wire.Contains("UNKNOWN") && wire.Contains("\"completed\":null") && !wire.Contains(reason) && !wire.Contains("reason"));
                    var reply=Contract.Json().DeserializeObject(wire) as System.Collections.Generic.Dictionary<string,object>;
                    Check(((System.Collections.Generic.Dictionary<string,object>)reply["receipt"]).Count==7);
                    Check(Exchange(name,request).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
                    Check(Exchange(name,Request("restart","omi_search","reload_runtime",key,"interrupt_current_requests")).Contains("REQUEST_CONFLICT"));
                    Check(Exchange(name,Request("status","","","","")).Contains("OWNER_OBSERVATION"));
                    Reject(()=>owner.CompleteRefusal(key,reason)); // cannot rewrite historical evidence
                }
                using(var owner=new Owner(name,root)) {
                    Check(owner.Dispatch(request).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
                    Reject(()=>owner.CompleteRefusal(key,reason));
                }
            }
            // A failed sidecar write preserves UNKNOWN and the no-replay reservation.
            string failedRoot=System.IO.Path.Combine(root,"diagnostic-failure");
            System.IO.Directory.CreateDirectory(failedRoot);
            System.IO.File.WriteAllText(System.IO.Path.Combine(failedRoot,"workspace-local-diagnostics"),"fixture");
            using(var owner=Open(name,failedRoot)) {
                string key=System.Guid.NewGuid().ToString("D");var request=Request("restart","codex_bridge","reload_runtime",key,"interrupt_current_requests");
                Check(Exchange(name,request).Contains("ACTION_ACCEPTED"));owner.TakePending();
                Reject(()=>owner.CompleteRefusal(key,"ACTIVE_WORK_PRESENT"));Check(!owner.HasActiveRequest);
                Check(Exchange(name,Request("receipt","","",key,"")).Contains("UNKNOWN"));
                Check(Exchange(name,request).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
            }
            return checks-before;
        }
        public static int Run(string root) {
            const string id="d18ce611-a930-449c-899c-d2e13e82bc13";
            foreach(string target in Contract.Ids) {
                Check(Request("status",target,"","","")["componentId"]==target);
                Check(Request("diagnostics",target,"","","")["componentId"]==target);
                Check(Request("preview",target,"reload_runtime","","")["action"]=="reload_runtime");
                Check(Request("restart",target,"reload_runtime",id,"interrupt_current_requests")["componentId"]==target);
            }
            foreach(string target in new [] {"project_reading","mcp_control_center","unknown","PERSONAL_ASSET_OS","../x"}) {
                Reject(()=>Request("diagnostics",target,"","",""));
                Reject(()=>Request("preview",target,"reload_runtime","",""));
                Reject(()=>Request("restart",target,"reload_runtime",id,"interrupt_current_requests"));
            }
            foreach(string confirmation in new [] {"","yes","true"}) Reject(()=>Request("restart","personal_asset_os","reload_runtime",id,confirmation));
            Reject(()=>Request("restart","personal_asset_os","restart_core",id,"interrupt_current_requests"));
            Reject(()=>Request("execute","personal_asset_os","reload_runtime",id,"interrupt_current_requests"));
            Reject(()=>Request("diagnostics","","","",""));
            Reject(()=>Request("diagnostics","codex_bridge","reload_runtime","",""));
            Reject(()=>Request("diagnostics","codex_bridge","",id,""));
            Reject(()=>Request("diagnostics","codex_bridge","","","interrupt_current_requests"));
            Reject(()=>Request("restart","personal_asset_os","reload_runtime","../x","interrupt_current_requests"));
            Reject(()=>Contract.Request("{\"v\":\"1\",\"v\":\"1\"}",new string('b',64)));
            var preview=Request("preview","personal_asset_os","reload_runtime","","");
            var reply=Contract.Json().DeserializeObject(Sample().Reply(preview)) as System.Collections.Generic.Dictionary<string,object>;
            Check((string)reply["code"]=="READ_ONLY_PREVIEW"); Check((bool)reply["allowed"]==false);
            var rows=new System.Collections.Generic.List<Row>();
            foreach(string target in Contract.Ids) rows.Add(new Row {componentId=target,status="Ready",observedAt=System.DateTimeOffset.UtcNow.AddMinutes(-2).ToString("o"),capabilities=new string[0]});
            Check(new Snapshot(rows.ToArray()).Reply(preview).Contains("SNAPSHOT_UNAVAILABLE"));
            var store=new ReceiptStore(root);
            Check(store.Read(id)==null);Check(!System.IO.Directory.Exists(System.IO.Path.Combine(root,"workspace-local-receipts")));
            var receipt=store.Reserve(id,"personal_asset_os");Check(receipt.outcome=="UNKNOWN");Reject(()=>store.Reserve(id,"personal_asset_os"));
            var reopened=new ReceiptStore(root);Check(reopened.Read(id).outcome=="UNKNOWN");
            reopened.Complete(id,"COMPLETED");Check(store.Read(id).outcome=="COMPLETED");
            Reject(()=>store.Read("../bad"));Reject(()=>store.Complete(id,"SUCCESS_GUESSED"));
            var name="mcpcc-local-fixture-"+System.Guid.NewGuid().ToString("N");
            using(var owner=Open(name,root)) { Check(owner.Running);Reject(()=>new Owner(name,root));Check(owner.TakePending()==null); }
            string requestId=System.Guid.NewGuid().ToString("D");
            var restart=Request("restart","personal_asset_os","reload_runtime",requestId,"interrupt_current_requests");
            using(var owner=new Owner(name,root)) {
                Check(owner.Dispatch(restart).Contains("ACTION_ACCEPTED"));
                Check(owner.Dispatch(restart).Contains("REQUEST_REPLAY"));
                Check(owner.Dispatch(Request("restart","personal_asset_os","reload_runtime",System.Guid.NewGuid().ToString("D"),"interrupt_current_requests")).Contains("ACTION_BUSY"));
                Check(owner.TakePending().requestId==requestId);Check(owner.TakePending()==null);
                Check(owner.HasActiveRequest);Check(owner.Dispatch(restart).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
            }
            // Lost owner after durable acceptance: observe UNKNOWN, never re-enqueue.
            using(var owner=new Owner(name,root)) {
                Check(owner.Dispatch(restart).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
                Check(owner.Dispatch(Request("receipt","","",requestId,"")).Contains("UNKNOWN"));
                var expiring=Request("restart","personal_asset_os","reload_runtime",System.Guid.NewGuid().ToString("D"),"interrupt_current_requests");
                Check(owner.Dispatch(expiring).Contains("ACTION_ACCEPTED"));Check(owner.TakePending(long.MaxValue)==null);
                Check(!owner.HasActiveRequest);Check(owner.Dispatch(expiring).Contains("REQUEST_REPLAY"));Check(owner.TakePending()==null);
            }
            // Every target persists its exact identity, survives reopening, and blocks
            // cross-target reuse before and after completion without any second dispatch.
            foreach(string target in Contract.Ids) {
                string key=System.Guid.NewGuid().ToString("D");
                var original=Request("restart",target,"reload_runtime",key,"interrupt_current_requests");
                using(var owner=new Owner(name,root)) {
                    Check(owner.Dispatch(original).Contains("ACTION_ACCEPTED"));
                    var pending=owner.TakePending();Check(pending.componentId==target && pending.requestId==key);
                    foreach(string other in Contract.Ids) if(other!=target) {
                        var conflict=owner.Dispatch(Request("restart",other,"reload_runtime",key,"interrupt_current_requests"));
                        Check(conflict.Contains("REQUEST_CONFLICT") && conflict.Contains("\"receipt\":null") && conflict.Contains("\"completed\":null"));
                        Check(owner.TakePending()==null);Check(owner.HasActiveRequest);
                        Check(owner.Dispatch(Request("restart",other,"reload_runtime",System.Guid.NewGuid().ToString("D"),"interrupt_current_requests")).Contains("ACTION_BUSY"));
                    }
                    owner.Complete(key,"COMPLETED");Check(!owner.HasActiveRequest);
                }
                using(var owner=new Owner(name,root)) {
                    Check(owner.Dispatch(original).Contains("REQUEST_REPLAY"));
                    foreach(string other in Contract.Ids) if(other!=target) {
                        Check(owner.Dispatch(Request("restart",other,"reload_runtime",key.ToUpperInvariant(),"interrupt_current_requests")).Contains("REQUEST_CONFLICT"));
                        Check(owner.TakePending()==null);
                    }
                    Check(store.Read(key).componentId==target && store.Read(key).outcome=="COMPLETED");
                    Check(owner.TryBeginShutdown());
                    Check(owner.Dispatch(Request("restart",target,"reload_runtime",System.Guid.NewGuid().ToString("D"),"interrupt_current_requests")).Contains("OWNER_CLOSING"));
                }
            }
            Reject(()=>store.Reserve(System.Guid.NewGuid().ToString("D"),"project_reading"));
            // Disk corruption and capacity fail closed; old UUIDs are never evicted.
            string corrupt=System.Guid.NewGuid().ToString("D");store.Reserve(corrupt,"codex_bridge");
            string corruptPath=System.IO.Path.Combine(root,"workspace-local-receipts",corrupt+".json");
            System.IO.File.WriteAllText(corruptPath,System.IO.File.ReadAllText(corruptPath).Replace("codex_bridge","project_reading"));
            Reject(()=>store.Read(corrupt));
            string capacityRoot=System.IO.Path.Combine(root,"capacity");var full=new ReceiptStore(capacityRoot);
            for(int i=0;i<256;i++) full.Reserve(System.Guid.NewGuid().ToString("D"),Contract.Ids[i%7]);
            Reject(()=>full.Reserve(System.Guid.NewGuid().ToString("D"),"codex_bridge"));
            return checks;
        }
    }
}
