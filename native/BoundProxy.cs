using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Globalization;

internal sealed class BoundInterface {
    internal readonly string Id;
    internal readonly int Index;
    internal BoundInterface(string id, int index) { Id = new Guid(id.Replace("guid:", "")).ToString(); Index = index; Current(); }
    internal NetworkInterface Current() {
        var nic = NetworkInterface.GetAllNetworkInterfaces().SingleOrDefault(value => String.Equals(value.Id.Trim('{', '}'), Id, StringComparison.OrdinalIgnoreCase));
        if (nic == null || nic.OperationalStatus != OperationalStatus.Up || nic.GetIPProperties().GetIPv4Properties().Index != Index) throw new IOException("The selected interface is unavailable or its identity changed.");
        return nic;
    }
    internal Socket Connect(IPAddress address, int port) {
        if (address.AddressFamily != AddressFamily.InterNetwork) throw new IOException("This isolated session requires IPv4; IPv6 never falls back to another interface.");
        var nic = Current();
        var source = nic.GetIPProperties().UnicastAddresses.FirstOrDefault(value => value.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(value.Address));
        if (source == null) throw new IOException("The selected interface has no IPv4 address.");
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        try {
            socket.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)31, IPAddress.HostToNetworkOrder(Index));
            socket.Bind(new IPEndPoint(source.Address, 0));
            socket.SendTimeout = 15000; socket.ReceiveTimeout = 15000;
            var pending = socket.BeginConnect(address, port, null, null);
            using (pending.AsyncWaitHandle) { if (!pending.AsyncWaitHandle.WaitOne(8000)) throw new IOException("The selected interface connection timed out."); }
            socket.EndConnect(pending); Current(); return socket;
        } catch { socket.Dispose(); throw; }
    }
    internal IPAddress Resolve(string host) {
        IPAddress literal; if (IPAddress.TryParse(host, out literal)) return literal;
        string name = new IdnMapping().GetAscii(host.TrimEnd('.')).ToLowerInvariant();
        if (name.Length > 253 || name.Split('.').Any(label => label.Length < 1 || label.Length > 63 || label.Any(c => !(Char.IsLetterOrDigit(c) || c == '-')))) throw new IOException("Invalid DNS name.");
        ushort id = (ushort)new Random(Guid.NewGuid().GetHashCode()).Next(65536);
        var query = new List<byte> { (byte)(id >> 8), (byte)id, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0 };
        foreach (string label in name.Split('.')) { query.Add((byte)label.Length); query.AddRange(Encoding.ASCII.GetBytes(label)); }
        query.AddRange(new byte[] { 0, 0, 1, 0, 1 });
        Exception last = null;
        foreach (var server in Current().GetIPProperties().DnsAddresses.Where(value => value.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(value))) {
            try {
                using (var socket = Connect(server, 53)) using (var stream = new NetworkStream(socket, false)) {
                    byte[] bytes = query.ToArray(); stream.WriteByte((byte)(bytes.Length >> 8)); stream.WriteByte((byte)bytes.Length); stream.Write(bytes, 0, bytes.Length);
                    byte[] size = ReadExact(stream, 2); int length = (size[0] << 8) | size[1];
                    if (length < 12 || length > 65535) throw new IOException("Invalid DNS response.");
                    bytes = ReadExact(stream, length);
                    if (U16(bytes, 0) != id || (bytes[2] & 0x80) == 0 || (bytes[3] & 15) != 0 || U16(bytes, 4) != 1) throw new IOException("DNS lookup failed.");
                    int offset = 12; SkipName(bytes, ref offset); offset += 4;
                    int count = U16(bytes, 6);
                    for (int i = 0; i < count; i++) { SkipName(bytes, ref offset); int type = U16(bytes, offset), cls = U16(bytes, offset + 2), n = U16(bytes, offset + 8); offset += 10; if (offset + n > bytes.Length) throw new IOException("Truncated DNS response."); if (type == 1 && cls == 1 && n == 4) return new IPAddress(bytes.Skip(offset).Take(4).ToArray()); offset += n; }
                    throw new IOException("No IPv4 answer from the selected interface DNS server.");
                }
            } catch (Exception error) { last = error; }
        }
        throw new IOException("Interface-bound DNS failed; system DNS fallback is disabled.", last);
    }
    private static int U16(byte[] bytes, int offset) { if (offset < 0 || offset + 2 > bytes.Length) throw new IOException("Truncated DNS response."); return (bytes[offset] << 8) | bytes[offset + 1]; }
    private static void SkipName(byte[] bytes, ref int offset) { int hops = 0; while (true) { if (offset >= bytes.Length || ++hops > 128) throw new IOException("Invalid DNS response name."); int n = bytes[offset++]; if (n == 0) return; if ((n & 0xc0) == 0xc0) { if (offset >= bytes.Length) throw new IOException("Truncated DNS pointer."); offset++; return; } if (n > 63 || offset + n > bytes.Length) throw new IOException("Invalid DNS response label."); offset += n; } }
    internal static byte[] ReadExact(Stream stream, int length) { var bytes = new byte[length]; int offset = 0; while (offset < length) { int read = stream.Read(bytes, offset, length - offset); if (read == 0) throw new EndOfStreamException(); offset += read; } return bytes; }
}

internal static class BoundProxy {
    private static readonly object Gate = new object();
    private static readonly HashSet<Socket> Connections = new HashSet<Socket>();
    private static int upstreamPort;
    private static string upstreamAuthorization;
    internal static bool Matches(string host, IEnumerable<string> domains) { return domains.Any(domain => host == domain || host.EndsWith("." + domain, StringComparison.Ordinal)); }
    internal static bool PublicAddress(IPAddress address) {
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        byte[] b = address.GetAddressBytes();
        return b[0] != 0 && b[0] != 10 && b[0] != 127 && b[0] < 224 && !(b[0] == 169 && b[1] == 254) && !(b[0] == 172 && b[1] >= 16 && b[1] <= 31) && !(b[0] == 192 && b[1] == 168) && !(b[0] == 100 && b[1] >= 64 && b[1] <= 127);
    }
    private static string[] Domains(Dictionary<string, object> config, string key) { object raw; if (!config.TryGetValue(key, out raw) || !(raw is object[])) throw new IOException("Invalid domain rules."); return ((object[])raw).Select(value => new IdnMapping().GetAscii((string)value).TrimEnd('.').ToLowerInvariant()).ToArray(); }
    private static string Header(Stream stream) {
        var bytes = new List<byte>();
        while (bytes.Count < 32768) { int c = stream.ReadByte(); if (c < 0) throw new EndOfStreamException(); bytes.Add((byte)c); int n = bytes.Count; if (n >= 4 && bytes[n - 4] == 13 && bytes[n - 3] == 10 && bytes[n - 2] == 13 && bytes[n - 1] == 10) return Encoding.ASCII.GetString(bytes.ToArray()); }
        throw new IOException("Oversized proxy header.");
    }
    private static void Write(Stream stream, string text) { byte[] bytes = Encoding.ASCII.GetBytes(text); stream.Write(bytes, 0, bytes.Length); }
    private static void Relay(Stream first, Stream second) {
        var forward = System.Threading.Tasks.Task.Factory.StartNew(() => { try { first.CopyTo(second); } catch (IOException) { } catch (ObjectDisposedException) { } finally { second.Close(); first.Close(); } });
        try { second.CopyTo(first); } catch (IOException) { } catch (ObjectDisposedException) { } finally { second.Close(); first.Close(); }
        forward.Wait();
    }
    internal static bool UseProxy(string host, string[] domains, string[] protectedDomains, string mode) {
        if (mode != "sites" && mode != "chatgpt-web") throw new IOException("Invalid routing mode.");
        return mode == "chatgpt-web" || (!Matches(host, protectedDomains) && Matches(host, domains));
    }
    internal static void ConfigureTunnel(Socket socket) {
        // Handshake timeouts must not become an idle deadline for HTTPS/WS.
        socket.ReceiveTimeout = 0; socket.SendTimeout = 0;
        socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
    }
    private static void Serve(Socket client, BoundInterface primary, string[] domains, string[] protectedDomains, string mode) {
        Socket remote = null;
        try {
            client.ReceiveTimeout = 15000; client.SendTimeout = 15000;
            using (var input = new NetworkStream(client, false)) {
                string header = Header(input); string[] lines = header.Split(new[] { "\r\n" }, StringSplitOptions.None); string[] request = lines[0].Split(' ');
                if (request.Length != 3 || request[2] != "HTTP/1.1") throw new IOException("Invalid proxy request.");
                bool tunnel = request[0] == "CONNECT";
                Uri target; if (!Uri.TryCreate(tunnel ? "https://" + request[1] + "/" : request[1], UriKind.Absolute, out target) || target.UserInfo.Length != 0 || (!tunnel && target.Scheme != "http") || (target.Port != 80 && target.Port != 443)) throw new IOException("Only HTTP and HTTPS website traffic is allowed.");
                string host = target.IdnHost.TrimEnd('.').ToLowerInvariant();
                IPAddress literal;
                if (host == "localhost" || host.EndsWith(".localhost", StringComparison.Ordinal) || (IPAddress.TryParse(host, out literal) && !PublicAddress(literal))) throw new IOException("Local and reserved destinations are blocked.");
                bool proxy = UseProxy(host, domains, protectedDomains, mode);
                if (proxy) {
                    int port = Volatile.Read(ref upstreamPort); if (port < 1) throw new IOException("The dedicated proxy is unavailable.");
                    remote = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                    remote.ReceiveTimeout = 15000; remote.SendTimeout = 15000; remote.Connect(IPAddress.Loopback, port);
                } else {
                    var address = primary.Resolve(host); if (!PublicAddress(address)) throw new IOException("Local, reserved and IPv6 destinations are blocked in the isolated browser.");
                    remote = primary.Connect(address, target.Port);
                }
                lock (Gate) Connections.Add(remote);
                using (var output = new NetworkStream(remote, false)) {
                    if (proxy) { Write(output, "CONNECT " + host + ":" + target.Port + " HTTP/1.1\r\nHost: " + host + ":" + target.Port + "\r\nProxy-Authorization: Basic " + upstreamAuthorization + "\r\n\r\n"); string response = Header(output); if (!response.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal) && !response.StartsWith("HTTP/1.0 200 ", StringComparison.Ordinal)) throw new IOException("The dedicated proxy rejected the connection."); }
                    Json.Emit(new { type = "connection", host = host, lane = proxy ? "proxy" : "primary", localAddress = ((IPEndPoint)remote.LocalEndPoint).Address.ToString(), interfaceIndex = proxy ? 0 : primary.Index, at = DateTime.UtcNow.ToString("o") });
                    if (tunnel) Write(input, "HTTP/1.1 200 Connection Established\r\n\r\n");
                    else {
                        var safe = new StringBuilder(request[0] + " " + target.PathAndQuery + " HTTP/1.1\r\nHost: " + target.Authority + "\r\nConnection: close\r\n");
                        foreach (string line in lines.Skip(1)) { int colon = line.IndexOf(':'); if (line.Length == 0) continue; if (colon < 1 || Char.IsWhiteSpace(line[0])) throw new IOException("Invalid HTTP header."); string key = line.Substring(0, colon).ToLowerInvariant(); if (key == "host" || key == "connection" || key.StartsWith("proxy-", StringComparison.Ordinal)) continue; safe.Append(line).Append("\r\n"); }
                        Write(output, safe.Append("\r\n").ToString());
                    }
                    ConfigureTunnel(client); ConfigureTunnel(remote);
                    Relay(input, output);
                }
            }
        } catch (Exception) { try { Write(new NetworkStream(client, false), "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch (Exception) { } }
        finally { lock (Gate) { Connections.Remove(client); if (remote != null) Connections.Remove(remote); } client.Dispose(); if (remote != null) remote.Dispose(); }
    }
    internal static int Run(Dictionary<string, object> configuration) {
        var primary = new BoundInterface(Json.Text(configuration, "primaryId"), Json.Integer(configuration, "primaryIndex"));
        var proxy = new BoundInterface(Json.Text(configuration, "proxyId"), Json.Integer(configuration, "proxyIndex"));
        if (primary.Id == proxy.Id) throw new IOException("Two different interfaces are required.");
        string[] domains = Domains(configuration, "domains"), protectedDomains = Domains(configuration, "protectedDomains");
        string mode = Json.Text(configuration, "mode"); UseProxy("", domains, protectedDomains, mode);
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Server.ExclusiveAddressUse = true; listener.Start(64);
        Program.ReadControl(value => {
            string type = Json.Text(value, "type");
            if (type == "upstream") { int port = Json.Integer(value, "port"); if (port < 1 || port > 65535) throw new IOException("Invalid upstream port."); upstreamAuthorization = Convert.ToBase64String(Encoding.UTF8.GetBytes(Json.Text(value, "username") + ":" + Json.Text(value, "password"))); Volatile.Write(ref upstreamPort, port); Json.Emit(new { type = "upstream-ready", id = Json.Text(value, "id") }); }
            else if (type == "resolve") { string host = Json.Text(value, "host"), id = Json.Text(value, "id"); var address = proxy.Resolve(host); if (!PublicAddress(address)) throw new IOException("The selected proxy node must have a public IPv4 endpoint."); Json.Emit(new { type = "resolved", id = id, address = address.ToString() }); }
            else throw new IOException("Unsupported proxy command.");
        });
        Json.Emit(new { type = "helper-ready", port = ((IPEndPoint)listener.LocalEndpoint).Port, proxyDns = proxy.Current().GetIPProperties().DnsAddresses.Where(value => value.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(value)).Select(value => value.ToString()).ToArray() });
        try {
            while (!Program.StopRequested && Program.HeartbeatAge <= 10) {
                primary.Current(); proxy.Current();
                if (listener.Pending()) { Socket client = listener.AcceptSocket(); lock (Gate) { if (Connections.Count >= 512) { client.Dispose(); continue; } Connections.Add(client); } ThreadPool.QueueUserWorkItem(_ => Serve(client, primary, domains, protectedDomains, mode)); }
                else Thread.Sleep(50);
            }
        } finally { listener.Stop(); lock (Gate) { foreach (var socket in Connections) socket.Dispose(); Connections.Clear(); } }
        Json.Emit(new { type = "stopped" }); return 0;
    }
}
