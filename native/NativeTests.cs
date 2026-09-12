using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Diagnostics;
using System.Security.Principal;
using System.Text;

internal static class NativeTests {
    internal static int Run(Dictionary<string, object> configuration) {
        object fixture;
        if (configuration.TryGetValue("tunnelFixture", out fixture) && fixture is bool && (bool)fixture) return TunnelFixture();
        if (configuration.TryGetValue("adapterHandshakeFixture", out fixture) && fixture is bool && (bool)fixture) return AdapterHandshakeFixture(configuration);
        if (!BoundProxy.Matches("api.openai.com", new[] { "openai.com" }) || BoundProxy.Matches("openai.com.evil.example", new[] { "openai.com" })) throw new Exception("Domain boundary regression.");
        if (BoundProxy.PublicAddress(IPAddress.Parse("127.0.0.1")) || BoundProxy.PublicAddress(IPAddress.Parse("::1")) || !BoundProxy.PublicAddress(IPAddress.Parse("1.1.1.1"))) throw new Exception("Address policy regression.");
        int attempts = 0;
        var failures = AdapterBroker.RestoreEach(new[] { new AdapterRecord(), new AdapterRecord() }, record => { attempts++; if (attempts == 1) throw new IOException("Missing first adapter"); });
        if (attempts != 2 || failures.Count != 1) throw new Exception("One missing adapter prevented other recovery attempts.");
        if (JobHandle.Quote("a\\") != "\"a\\\\\"") throw new Exception("Windows argument quoting regression.");
        bool rejected = false;
        try { new BoundInterface("00000000-0000-0000-0000-000000000000", Int32.MaxValue); } catch (IOException) { rejected = true; }
        if (!rejected) throw new Exception("An unavailable interface must not use the system default.");
        if (BoundProxy.UseProxy("chatgpt.com", new[] { "com" }, new[] { "chatgpt.com" }, "sites")) throw new Exception("Website mode lost OpenAI protection.");
        foreach (string domain in new[] { "chatgpt.com", "auth.openai.com", "login.example.net", "new-cdn.example.org" })
            if (!BoundProxy.UseProxy(domain, new string[0], new[] { "chatgpt.com", "openai.com" }, "chatgpt-web")) throw new Exception("Web mode omitted a session dependency.");
        rejected = false;
        try { BoundProxy.UseProxy("chatgpt.com", new string[0], new string[0], "desktop"); } catch (IOException) { rejected = true; }
        if (!rejected) throw new Exception("Unknown routing mode was accepted.");
        Json.Emit(new { type = "passed", tests = 8 }); return 0;
    }

    private static int AdapterHandshakeFixture(Dictionary<string, object> configuration) {
        // Authentication is the production implementation. This fixture has no
        // elevation, adapter mutation, or recovery-store access.
        string name = Json.Text(configuration, "pipeName");
        if (!name.StartsWith("cherry-adapter-", StringComparison.Ordinal) || name.Length != 47) throw new IOException("Invalid test pipe.");
        int parentId = Convert.ToInt32(configuration["parentPid"]);
        using (var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536)) {
            Json.Emit(new { type = "adapter-test-listening" });
            AdapterBroker.WaitForParent(pipe, 10000);
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false))) {
                writer.AutoFlush = true;
                try {
                    Program.LastHeartbeat = 0;
                    object rejectAccount;
                    string sid = configuration.TryGetValue("rejectAccount", out rejectAccount) && rejectAccount is bool && (bool)rejectAccount
                        ? "S-1-0-0" : WindowsIdentity.GetCurrent().User.Value;
                    AdapterBroker.AuthenticateParent(pipe, parentId, sid);
                    if (Program.HeartbeatAge > 1) throw new IOException("Handshake did not reset the heartbeat.");
                    writer.WriteLine(Json.Encode(new { type = "ready", protocol = AdapterBroker.Protocol, pid = Process.GetCurrentProcess().Id }));
                    using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true)) {
                        string line;
                        while ((line = reader.ReadLine()) != null) {
                            var command = Json.Decode(line);
                            if (Json.Text(command, "type") == "heartbeat") continue;
                            if (Json.Text(command, "type") != "restore") throw new IOException("The authentication fixture accepts only an empty restore.");
                            writer.WriteLine(Json.Encode(new { type = "result", id = Json.Text(command, "id") }));
                            break;
                        }
                    }
                } catch (Exception error) { writer.WriteLine(Json.Encode(new { type = "error", phase = "handshake", message = error.Message, code = error.HResult & 0xffff })); return 1; }
            }
        }
        return 0;
    }

    private static int TunnelFixture() {
        // Loopback-only fixture exercises the production established-socket
        // configuration after the old 15-second read deadline has elapsed.
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(1);
        try {
            Json.Emit(new { type = "tunnel-ready", port = ((IPEndPoint)listener.LocalEndpoint).Port });
            using (var socket = listener.AcceptSocket()) {
                socket.ReceiveTimeout = 15000; socket.SendTimeout = 15000;
                BoundProxy.ConfigureTunnel(socket);
                var bytes = new byte[32768]; int count;
                while ((count = socket.Receive(bytes)) > 0) {
                    for (int sent = 0; sent < count;) sent += socket.Send(bytes, sent, count - sent, SocketFlags.None);
                }
            }
        } finally { listener.Stop(); }
        return 0;
    }
}
