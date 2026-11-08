import { EMPTY } from '../lib/empty';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type { Assignment, Responder, Role } from '../api/models';
import { IcSearch } from '../components/icons';
import { ConfirmDialog, Empty, ErrorBox, Modal, Pill, Seg, StatCard } from '../components/ui';
import { errorMessage, qk, useAction, useActiveAssignments, useAssignmentActions, useCaseEvents, useOpenCases, useResponders } from '../hooks/data';
import { formatAge, formatDateTime } from '../lib/time';
import { shortId } from '../lib/tier';
import { useAuth, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';
import { useNow } from '../hooks/useNow';

type F = 'all' | 'responder' | 'volunteer' | 'available' | 'in_app';

function ResponderForm({ initial, onClose }: { initial?: Responder; onClose: () => void }) {
  const edit = !!initial;
  const [username, setUsername] = useState(initial?.username ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? 'responder');
  const [skills, setSkills] = useState((initial?.skills ?? []).join(', '));
  const [org, setOrg] = useState(initial?.organization ?? '');
  const [password, setPassword] = useState('');
  const [available, setAvailable] = useState(initial?.available ?? true);
  const [err, setErr] = useState<string | null>(null);
  const save = useAction(
    async () => {
      const sk = skills.split(',').map((s) => s.trim()).filter(Boolean);
      if (edit) return api.updateResponder(initial.id, { name, role, skills: sk, organization: org || undefined, available, ...(password ? { password } : {}) });
      return api.createResponder({ username, password, name, role, skills: sk, organization: org || undefined });
    },
    {
      success: edit ? 'Responder updated' : 'Responder created',
      invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.responders }),
      onError: (e) => {
        setErr(e instanceof ApiError && e.status === 409 ? 'That username is already taken.' : errorMessage(e));
        return true;
      },
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    save.mutate(undefined, { onSuccess: onClose });
  };
  return (
    <Modal title={edit ? `Edit ${initial.name}` : 'Add a responder'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid" style={{ padding: 0 }}>
          <div className="field"><label htmlFor="r-user">Username</label><input id="r-user" value={username} onChange={(e) => setUsername(e.target.value)} required disabled={edit} data-autofocus={!edit || undefined} /></div>
          <div className="field"><label htmlFor="r-name">Name</label><input id="r-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="field"><label htmlFor="r-role">Role</label>
            <select id="r-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="responder">Responder</option><option value="volunteer">Volunteer</option><option value="admin">Admin</option>
            </select>
          </div>
          <div className="field"><label htmlFor="r-org">Organization</label><input id="r-org" value={org} onChange={(e) => setOrg(e.target.value)} /></div>
          <div className="field full"><label htmlFor="r-skills">Skills</label><input id="r-skills" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="boat, medical, first aid" /><span className="hint">Comma separated. Used for filters.</span></div>
          <div className="field full"><label htmlFor="r-pw">{edit ? 'New password (leave empty to keep)' : 'Password'}</label><input id="r-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required={!edit} minLength={edit && !password ? 0 : 8} /></div>
          {edit && <label className="full" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, fontSize: 13 }}><input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} /> Available for assignments</label>}
        </div>
        {err && <div className="form-err" role="alert" style={{ padding: '8px 0 0' }}>{err}</div>}
        <div className="acts" style={{ padding: '14px 0 0' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : edit ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

const STEPS = [
  { k: 'reported', label: 'Reported' },
  { k: 'assigned', label: 'Assigned' },
  { k: 'en_route', label: 'En route' },
  { k: 'on_scene', label: 'On scene' },
  { k: 'resolved', label: 'Resolved' },
] as const;

function AssignmentSteps({ a, r }: { a: Assignment; r?: Responder }) {
  const nav = useNavigate();
  const select = useUi((s) => s.select);
  const me = useAuth((s) => s.responder);
  const isAdmin = useIsAdmin();
  const events = useCaseEvents(a.sos_id);
  const open = useOpenCases();
  const c = open.data?.find((x) => x.id === a.sos_id);
  const { update, release } = useAssignmentActions();
  const [confirm, setConfirm] = useState(false);
  const at = (t: string) => events.data?.find((e) => e.type === t)?.at;
  const idx = STEPS.findIndex((s) => s.k === a.status);
  const can = isAdmin || me?.id === a.responder_id;
  const note: Record<string, string> = {
    reported: c ? `${formatDateTime(c.created_at)}, ${c.channel === 'mesh' ? `mesh, ${c.hop?.hop_count ?? '?'} hops` : 'app'}` : (at('reported') ? formatDateTime(at('reported')) : ''),
    assigned: `${formatDateTime(at('assigned') ?? a.created_at)}, claimed by ${a.responder_name ?? r?.name ?? 'responder'}`,
    en_route: at('en_route') ? `${formatDateTime(at('en_route'))}${a.eta_minutes ? `. ETA ${a.eta_minutes} min` : ''}` : a.eta_minutes && a.status === 'assigned' ? `ETA ${a.eta_minutes} min` : 'Waiting',
    on_scene: at('on_scene') ? formatDateTime(at('on_scene')) : 'Waiting',
    resolved: at('resolved') ? formatDateTime(at('resolved')) : 'Waiting',
  };
  return (
    <div className="card">
      <div className="card-h"><h2>{a.responder_name ?? r?.name ?? 'Responder'}, {shortId(a.sos_id)}</h2><Pill bg="var(--blue-soft)" color="var(--blue)">{a.status.replace('_', ' ')}</Pill></div>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s.k} className={i < idx || a.status === 'resolved' ? 'done' : i === idx ? 'now' : ''}>
            <i />
            <div><b>{s.label}</b><p>{note[s.k] || 'Waiting'}</p></div>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 18px 18px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => { select(a.sos_id); nav('/queue'); }}>Open case</button>
        {can && a.status === 'assigned' && <button className="btn primary" disabled={update.isPending} onClick={() => update.mutate({ assignment: a, status: 'en_route' })}>Mark en route</button>}
        {can && a.status === 'en_route' && <button className="btn primary" disabled={update.isPending} onClick={() => update.mutate({ assignment: a, status: 'on_scene' })}>Mark on scene</button>}
        {can && a.status === 'on_scene' && <button className="btn primary" onClick={() => { select(a.sos_id); nav('/queue'); }}>Resolve in case view</button>}
        {can && <button className="btn" onClick={() => setConfirm(true)}>Release case</button>}
      </div>
      {confirm && <ConfirmDialog title="Release this case?" confirmLabel="Release" busy={release.isPending} body="It goes back to the queue." onClose={() => setConfirm(false)} onConfirm={() => release.mutate({ assignment: a }, { onSuccess: () => setConfirm(false) })} />}
    </div>
  );
}

export function Responders() {
  const now = useNow();
  const isAdmin = useIsAdmin();
  const me = useAuth((s) => s.responder);
  const resp = useResponders();
  const asg = useActiveAssignments();
  const resolved = useQuery({ queryKey: [...qk.assignments, 'resolved'], queryFn: () => api.fetchAll((cursor) => api.listAssignments({ status: ['resolved'], cursor, limit: 200 }), 2000) });
  const [f, setF] = useState<F>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'new' | Responder>(null);
  const [del, setDel] = useState<Responder | null>(null);
  const remove = useAction((id: string) => api.deleteResponder(id), {
    success: 'Responder deleted',
    invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.responders }),
  });
  const toggleAvail = useAction((r: Responder) => api.updateResponder(r.id, { available: !r.available }), {
    invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.responders }),
  });

  const list: Responder[] = resp.data ?? EMPTY;
  const byResp = useMemo(() => {
    const m = new Map<string, Assignment>();
    for (const a of asg.data ?? []) m.set(a.responder_id, a);
    return m;
  }, [asg.data]);
  const counts = useMemo(() => {
    let available = 0, enroute = 0, onscene = 0;
    for (const r of list) {
      if (r.role === 'admin') continue;
      const a = byResp.get(r.id);
      if (!a) { if (r.available) available++; } else if (a.status === 'on_scene') onscene++; else enroute++;
    }
    return { available, enroute, onscene };
  }, [list, byResp]);
  const today = (resolved.data ?? []).filter((a) => a.resolved_at && new Date(a.resolved_at).toDateString() === new Date(now).toDateString()).length;

  const rows = list.filter((r) => {
    if (f === 'responder' && r.role !== 'responder') return false;
    if (f === 'volunteer' && r.role !== 'volunteer') return false;
    if (f === 'available' && (r.role === 'admin' || !(r.available && !byResp.has(r.id)))) return false;
    if (f === 'in_app' && !r.in_app) return false;
    const s = q.trim().toLowerCase();
    return !s || [r.name, r.username, r.organization ?? '', ...(r.skills ?? [])].some((x) => x.toLowerCase().includes(s));
  });
  const selected = list.find((r) => r.id === sel);
  const selAsg = sel ? byResp.get(sel) : undefined;

  return (
    <div className="view on">
      <section className="stats" aria-label="Responder numbers">
        <StatCard value={counts.available} valueColor="var(--green)" label="Available" loading={resp.isLoading} />
        <StatCard value={counts.enroute} valueColor="var(--blue)" label="Assigned / en route" loading={asg.isLoading} />
        <StatCard value={counts.onscene} valueColor="#C2410C" label="On scene" loading={asg.isLoading} />
        <StatCard value={resolved.data ? today : '-'} label="Cases resolved today" loading={resolved.isLoading} />
      </section>
      <div className="rgrid">
        <div className="card">
          <div className="toolbar">
            <Seg<F> label="Responder filter" value={f} onChange={setF} options={[{ v: 'all', label: 'All teams' }, { v: 'responder', label: 'Responders' }, { v: 'volunteer', label: 'Volunteers' }, { v: 'available', label: 'Available' }, { v: 'in_app', label: 'In app' }]} />
            <label className="search"><IcSearch width={16} height={16} /><span className="sr-only">Find a team or skill</span><input type="search" placeholder="Find a team or skill" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            {isAdmin && <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setForm('new')}>Add responder</button>}
          </div>
          {resp.isError && <ErrorBox error={resp.error} onRetry={() => void resp.refetch()} />}
          <div className="tbl-wrap">
            <table className="tbl" aria-label="Responders">
              <thead><tr><th>Team</th><th>Presence</th><th>Type</th><th>Skills</th><th>Status</th><th>Case</th><th>ETA</th><th>Last seen</th>{isAdmin && <th><span className="sr-only">Admin</span></th>}</tr></thead>
              <tbody>
                {resp.isLoading && Array.from({ length: 4 }, (_, i) => <tr key={i}><td colSpan={9}><div className="skel" style={{ height: 34 }} /></td></tr>)}
                {rows.map((r) => {
                  const a = byResp.get(r.id);
                  const lastSeen = r.last_app_seen_at ?? r.last_seen_at;
                  return (
                    <tr key={r.id} tabIndex={0} className={`row-click${r.id === sel ? ' sel' : ''}`} onClick={() => setSel(r.id)} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setSel(r.id); } }}>
                      <td><b>{r.name}{r.id === me?.id ? ' (you)' : ''}</b><p>{r.organization ?? `@${r.username}`}</p></td>
                      <td>
                        <span className={`cchip ${r.in_app ? 'green' : 'gray'}`} title={r.in_app ? 'Online in mobile app' : 'Offline'}>
                          <i aria-hidden="true" />
                          <span>{r.in_app ? 'In app' : 'Offline'}</span>
                        </span>
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{r.role}</td>
                      <td><span className="tags sm">{(r.skills ?? []).length ? r.skills?.map((s) => <span key={s}>{s}</span>) : <span>-</span>}</span></td>
                      <td>{a ? <span className={`st ${a.status === 'on_scene' ? 'os' : a.status === 'en_route' ? 'enr' : 'asg'}`}>{a.status === 'on_scene' ? 'On scene' : a.status === 'en_route' ? 'En route' : 'Assigned'}</span> : <span className={`st ${r.available ? 'av' : 'new'}`}>{r.available ? 'Available' : 'Off duty'}</span>}</td>
                      <td>{a ? shortId(a.sos_id) : '-'}</td>
                      <td>{a?.eta_minutes ? `${a.eta_minutes} min` : '-'}</td>
                      <td>{lastSeen ? formatAge(lastSeen, now) : '-'}</td>
                      {isAdmin && (
                        <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setForm(r)} aria-label={`Edit ${r.name}`}>Edit</button>{' '}
                          <button className="btn sm" disabled={toggleAvail.isPending} onClick={() => toggleAvail.mutate(r)}>{r.available ? 'Set off duty' : 'Set available'}</button>{' '}
                          {r.id !== me?.id && <button className="btn sm danger" onClick={() => setDel(r)} aria-label={`Delete ${r.name}`}>Delete</button>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!resp.isLoading && rows.length === 0 && <Empty>No responders match.</Empty>}
        </div>
        {selAsg ? <AssignmentSteps a={selAsg} r={selected} /> : (
          <div className="card"><Empty>{selected ? `${selected.name} has no active case.` : 'Select a team to follow its active case from reported to resolved.'}</Empty></div>
        )}
      </div>
      {form && <ResponderForm initial={form === 'new' ? undefined : form} onClose={() => setForm(null)} />}
      {del && <ConfirmDialog title={`Delete ${del.name}?`} danger confirmLabel="Delete" busy={remove.isPending} body="They can no longer sign in. Their past assignments stay in the audit trail." onClose={() => setDel(null)} onConfirm={() => remove.mutate(del.id, { onSuccess: () => setDel(null) })} />}
    </div>
  );
}
