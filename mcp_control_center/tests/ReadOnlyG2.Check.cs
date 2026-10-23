// Compiled into the same temporary assembly as the source for isolated tests.
// Never shipped in a protected install; never uses the production pipe name.
namespace McpCc.ReadOnlyG2 {
    public static class Fixture {
        public static Owner OpenForNode(string name) {
            if(!System.Text.RegularExpressions.Regex.IsMatch(name,"\\Amcpcc-g2-fixture-[0-9a-f]{32}\\z")) throw new System.InvalidOperationException("FIXTURE_NAME_REQUIRED");
            using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())
            using(var process=System.Diagnostics.Process.GetCurrentProcess()) {
                var owner=new Owner(new Binding {clientSid=identity.User.Value,clientSession=process.SessionId},name);
                owner.Publish(new Snapshot(Rows()));owner.Start();return owner;
            }
        }
        static int checks;
        static void Check(bool value,string label) { if(!value) throw new System.Exception("FIXTURE_FAILED: "+label);checks++; }
        static void Reject(System.Action action,string label) { bool rejected=false;try { action(); } catch { rejected=true; }Check(rejected,label); }
        static Row[] Rows() {
            var rows=new System.Collections.Generic.List<Row>();
            foreach(string id in Contract.Ids) rows.Add(new Row {componentId=id,status="Ready",observedAt=System.DateTimeOffset.UtcNow.ToString("o"),capabilities=new string[]{"restart_core"}});
            return rows.ToArray();
        }
        static string Request(string challenge,string operation,string id,string action,string receipt) {
            return Contract.Json().Serialize(new {v="1",nonce=Contract.Nonce(),challenge=challenge,operation=operation,componentId=id,action=action,requestId=receipt});
        }
        public static int Run() {
            checks=0;string challenge=Contract.Nonce();var snapshot=new Snapshot(Rows());
            Reject(()=>Installation.AssertOwnerSource(),"owner process source not attested");
            Reject(()=>Owner.Open(),"production owner cannot activate from a fixture/dev process");
            foreach(string id in Contract.Ids) foreach(string action in Contract.Actions) {
                var parsed=Contract.Request(Request(challenge,"preview",id,action,""),challenge);
                var r=Contract.Json().Deserialize<System.Collections.Generic.Dictionary<string,object>>(snapshot.Reply(parsed));
                Check((bool)r["allowed"]==false && (bool)r["executable"]==false,"35 previews never execute");
            }
            foreach(string id in new string[]{"project_reading","mcp_control_center","unknown","CODEX_BRIDGE","../codex_bridge"})
                Reject(()=>Contract.Request(Request(challenge,"status",id,"",""),challenge),"self/unknown rejected");
            string valid=Request(challenge,"status","personal_asset_os","","");
            foreach(string bad in new string[]{valid.Replace("\"v\":\"1\"","\"v\":\"1\",\"v\":\"1\""),valid.Replace("\"v\":\"1\"","\"V\":\"1\""),valid.Replace("\"v\":\"1\"","\"v\":\"2\""),
                valid.Replace("\"operation\":\"status\"","\"operation\":\"execute\""),valid.Replace("{","{\"command\":\"whoami\","),"[]","null",new string('x',2049)})
                Reject(()=>Contract.Request(bad,challenge),"malformed/extra/version/execute");
            Reject(()=>Contract.Request(valid,Contract.Nonce()),"replay from another connection");
            var receipt=Contract.Request(Request(challenge,"receipt","","","c76f284e-e798-49eb-ae0c-a6d27189d0e7"),challenge);
            string receiptText=snapshot.Reply(receipt);
            Check(receiptText.Contains("RECEIPT_SOURCE_UNAVAILABLE") && receiptText.Contains("\"found\":null") && receiptText.Contains("\"completed\":null"),"no invented receipt");
            var rows=Rows();rows[0].status="private payload";Reject(()=>new Snapshot(rows),"status sanitizer");
            rows=Rows();rows[0].componentId=rows[1].componentId;Reject(()=>new Snapshot(rows),"duplicate sample");
            rows=Rows();rows[0].observedAt="2000-01-01T00:00:00Z";Reject(()=>new Snapshot(rows),"stale sample");
            rows=Rows();rows[0].capabilities=new string[]{"execute"};Reject(()=>new Snapshot(rows),"capability sanitizer");
            var acl=new System.Security.AccessControl.DirectorySecurity();
            acl.SetSecurityDescriptorSddlForm("O:SYG:SYD:P(A;;FA;;;SY)(A;;FR;;;BU)");Installation.Acl(acl,false);Check(true,"protected ACL fixture");
            acl.SetSecurityDescriptorSddlForm("O:SYG:SYD:P(A;;FA;;;SY)(A;;FW;;;BU)");Reject(()=>Installation.Acl(acl,false),"writable code rejected");
            acl.SetSecurityDescriptorSddlForm("O:BUG:BUD:P(A;;FA;;;SY)");Reject(()=>Installation.Acl(acl,false),"untrusted file owner rejected");
            acl.SetSecurityDescriptorSddlForm("O:SYG:SYD:NO_ACCESS_CONTROL");Reject(()=>Installation.Acl(acl,false),"null DACL rejected");

            using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())
            using(var process=System.Diagnostics.Process.GetCurrentProcess()) {
                string sid=identity.User.Value;
                Reject(()=>new Peer(process.Id,sid,process.SessionId,process.StartTime.ToUniversalTime().Ticks+1,process.MainModule.FileName),"PID start mismatch");
                Reject(()=>new Peer(process.Id,"S-1-5-18",process.SessionId,process.StartTime.ToUniversalTime().Ticks,process.MainModule.FileName),"SID mismatch");
                var b=new Binding {clientSid=sid,clientSession=process.SessionId};
                string pipeName="mcpcc-g2-fixture-"+System.Guid.NewGuid().ToString("N");
                using(var owner=new Owner(b,pipeName)) {
                    owner.Publish(snapshot);owner.Start();
                    using(var peer=new Peer(process.Id,sid,process.SessionId,process.StartTime.ToUniversalTime().Ticks,process.MainModule.FileName)) {
                        string text=Client.Exchange(pipeName,"preview","personal_asset_os","restart_core","",Contract.Nonce(),peer);
                        Check(text.Contains("READ_ONLY_PREVIEW") && text.Contains("\"allowed\":false"),"real isolated named pipe + kernel server PID");
                    }
                }
                // Wrong client OS principal is rejected before request handling.
                b=new Binding {clientSid="S-1-5-18",clientSession=process.SessionId};
                pipeName="mcpcc-g2-fixture-"+System.Guid.NewGuid().ToString("N");
                using(var owner=new Owner(b,pipeName)) {
                    owner.Publish(snapshot);owner.Start();
                    Reject(()=>Client.Exchange(pipeName,"preview","personal_asset_os","restart_core","",Contract.Nonce(),null),"wrong client SID");
                }
                // An authenticated client withholding its request is bounded.
                b=new Binding {clientSid=sid,clientSession=process.SessionId};
                pipeName="mcpcc-g2-fixture-"+System.Guid.NewGuid().ToString("N");
                using(var owner=new Owner(b,pipeName)) {
                    owner.Publish(snapshot);owner.Start();
                    using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",pipeName,System.IO.Pipes.PipeDirection.InOut,System.IO.Pipes.PipeOptions.Asynchronous)) {
                        pipe.Connect(1000);var clock=System.Diagnostics.Stopwatch.StartNew();
                        Frame.Read(pipe,clock);
                        Reject(()=>Frame.Read(pipe,clock),"idle frame timeout");
                        Check(clock.ElapsedMilliseconds<Contract.DeadlineMs+1500,"absolute frame deadline");
                    }
                }
            }
            return checks;
        }
    }
}
