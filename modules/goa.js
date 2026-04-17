import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const OAUTH2_XML = `
<node>
  <interface name="org.gnome.OnlineAccounts.OAuth2Based">
    <method name="GetAccessToken">
      <arg type="s" direction="out" name="access_token"/>
      <arg type="i" direction="out" name="expires_in"/>
    </method>
  </interface>
</node>`;

const OAuth2Proxy = Gio.DBusProxy.makeProxyWrapper(OAUTH2_XML);

let _cached = {email: null, token: null, expiresAt: 0};

export async function listGoogleAccounts() {
    const connection = Gio.DBus.session;
    const reply = await new Promise((resolve, reject) => {
        connection.call(
            'org.gnome.OnlineAccounts',
            '/org/gnome/OnlineAccounts',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null, null,
            Gio.DBusCallFlags.NONE,
            -1, null,
            (_, res) => {
                try { resolve(connection.call_finish(res)); }
                catch (e) { reject(e); }
            });
    });
    const [objects] = reply.deepUnpack();
    const accounts = [];
    for (const [path, ifaces] of Object.entries(objects)) {
        const acct = ifaces['org.gnome.OnlineAccounts.Account'];
        if (!acct) continue;
        if (acct.ProviderType !== 'google') continue;
        accounts.push({
            path,
            email: acct.Identity,
            filesDisabled: acct.FilesDisabled ?? false,
            calendarDisabled: acct.CalendarDisabled ?? false,
            todoDisabled: acct.TodoDisabled ?? false,
        });
    }
    return accounts;
}

export async function getAccessToken(email) {
    const now = GLib.get_monotonic_time() / 1_000_000;
    if (_cached.email === email && _cached.token && _cached.expiresAt > now + 30) {
        return _cached.token;
    }
    const accounts = await listGoogleAccounts();
    const match = accounts.find(a => a.email === email);
    if (!match) throw new Error(`No GOA account for ${email}`);

    const proxy = OAuth2Proxy(Gio.DBus.session, 'org.gnome.OnlineAccounts', match.path);
    const [token, expiresIn] = await new Promise((resolve, reject) => {
        proxy.GetAccessTokenRemote((result, err) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
    _cached = {email, token, expiresAt: now + expiresIn};
    return token;
}
