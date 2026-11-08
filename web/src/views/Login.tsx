import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../state/auth';
import { LogoMark } from '../components/icons';

export function Login() {
  const login = useAuth((s) => s.login);
  const notice = useAuth((s) => s.error);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(username.trim(), password);
    } catch (x) {
      setErr(x instanceof ApiError ? (x.status === 401 ? 'Wrong username or password.' : x.status === 429 ? 'Too many attempts. Wait a minute and try again.' : x.message) : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <main className="login-card">
        <h1 className="sr-only">Beacon responder sign-in</h1>
        <div className="logo">
          <LogoMark />
          <b>beacon</b>
        </div>
        <p className="sub2">Responder sign-in. Beacon relays SOS messages phone to phone until one reaches the internet, then ranks them for you.</p>
        <form onSubmit={(e) => void submit(e)}>
          {(err ?? notice) && (
            <div className="errbox" role="alert" style={{ margin: 0 }}>
              {err ?? notice}
            </div>
          )}
          <div className="field">
            <label htmlFor="u">Username</label>
            <input id="u" name="username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p">Password</label>
            <input id="p" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn primary" type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {import.meta.env.DEV && <p className="hint2">Demo accounts: <code>admin</code>, <code>alice</code>, <code>bob</code>, <code>carol</code>. The password is the server's <code>SEED_PASSWORD</code> (default <code>beacon-demo</code>).</p>}
      </main>
    </div>
  );
}
