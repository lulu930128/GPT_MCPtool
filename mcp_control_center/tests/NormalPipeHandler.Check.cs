using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Fixed synthetic payloads only; no Grant, secret, runner or service dependency.
public static class NormalPipeHandlerCheck {
    public static string Run() {
        using (var process=Process.GetCurrentProcess()) {
            var identity=McpCcNormalNative.Inspect(process);
            using (var peer=McpCcNormalPipe.Peer.Retain(identity.pid,identity.sid,identity.image,
                identity.session,identity.startedUtcTicks,false)) {
                var id=Guid.NewGuid();
                using(var listener=new McpCcNormalPipe.Listener(id,peer)) {
                    int calls=0;
                    var serving=Task.Run(() => listener.Exchange(request => {
                        calls++;
                        if (Encoding.UTF8.GetString(request)!="read-this-request")
                            throw new InvalidOperationException("REQUEST_NOT_PASSED_TO_HANDLER");
                        return Encoding.UTF8.GetBytes("verified:"+Encoding.UTF8.GetString(request));
                    }));
                    var response=McpCcNormalPipe.Exchange(id,peer,Encoding.UTF8.GetBytes("read-this-request"));
                    if (!serving.Wait(7000) || calls!=1 || Encoding.UTF8.GetString(response)!="verified:read-this-request")
                        throw new InvalidOperationException("HANDLER_ORDER_FAILED");
                }
                id=Guid.NewGuid();
                using(var listener=new McpCcNormalPipe.Listener(id,peer)) {
                    var serving=Task.Run(() => {
                        try {
                            listener.Exchange(request => { throw new InvalidOperationException("REJECTED_BY_HANDLER"); });
                            return false;
                        } catch (InvalidOperationException error) {
                            return error.Message=="REJECTED_BY_HANDLER";
                        }
                    });
                    bool closed=false;
                    try { McpCcNormalPipe.Exchange(id,peer,Encoding.UTF8.GetBytes("reject-this-request")); }
                    catch (EndOfStreamException) { closed=true; }
                    catch (IOException) { closed=true; }
                    catch (AggregateException error) {
                        if (!(error.GetBaseException() is IOException)) throw;
                        closed=true;
                    }
                    if (!serving.Wait(7000) || !serving.Result || !closed)
                        throw new InvalidOperationException("REJECTION_SENT_RESPONSE");
                }
            }
            return "PASS_ISOLATED_HANDLER_ONLY";
        }
    }
}
