import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Offer, OfferMatch, Sos } from '../api/models';
import { KIND_LABEL } from '../components/cards';
import { ConfirmDialog, Empty, ErrorBox, Modal, Pill, ScoreSq } from '../components/ui';
import { qk, useAction, useOffers, useOpenCases } from '../hooks/data';
import { needsByCategory } from '../lib/stats';
import { caseTitle, shortId } from '../lib/tier';
import { formatAge, formatDateTime } from '../lib/time';
import { useCanAct } from '../state/auth';
import { useNow } from '../hooks/useNow';

const MATCH_CLASS: Record<OfferMatch['status'], string> = { suggested: 'new', accepted: 'enr', declined: 'new', completed: 'res' };
const MATCH_LABEL: Record<OfferMatch['status'], string> = { suggested: 'Suggested', accepted: 'On the way', declined: 'Declined', completed: 'Delivered' };

function ManualMatch({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const open = useOpenCases();
  const [pick, setPick] = useState('');
  const m = useAction((sos: string) => api.createMatch(offer.id, sos), {
    success: 'Match sent',
    invalidate: (qc) => { void qc.invalidateQueries({ queryKey: qk.matches(offer.id) }); void qc.invalidateQueries({ queryKey: qk.offers }); },
  });
  return (
    <Modal title={`Match "${offer.description ?? KIND_LABEL[offer.kind]}" to a case`} onClose={onClose}
      actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!pick || m.isPending} onClick={() => m.mutate(pick, { onSuccess: onClose })}>{m.isPending ? 'Sending…' : 'Send match'}</button></>}>
      <div style={{ maxHeight: 300, overflow: 'auto' }}>
        {(open.data ?? []).map((c: Sos) => (
          <label key={c.id} className="matchli" style={{ cursor: 'pointer' }}>
            <input type="radio" name="case" checked={pick === c.id} onChange={() => setPick(c.id)} />
            <ScoreSq c={c} /><span><b>{shortId(c.id)}</b> {caseTitle(c, 44)}</span>
          </label>
        ))}
        {!open.data?.length && <Empty>No open cases.</Empty>}
      </div>
    </Modal>
  );
}

export function Assist() {
  const now = useNow();
  const canAct = useCanAct();
  const offers = useOffers();
  const cases = useOpenCases();
  const list = offers.data ?? [];
  const matchQs = useQueries({ queries: list.map((o) => ({ queryKey: qk.matches(o.id), queryFn: async () => (await api.listMatches(o.id)).data })) });
  const matchesBy = new Map(list.map((o, i) => [o.id, matchQs[i]?.data ?? []] as const));
  const [manual, setManual] = useState<Offer | null>(null);
  const [withdraw, setWithdraw] = useState<Offer | null>(null);
  const invalidate = (offerId: string) => (qc: import('@tanstack/react-query').QueryClient) => {
    void qc.invalidateQueries({ queryKey: qk.matches(offerId) });
    void qc.invalidateQueries({ queryKey: qk.offers });
  };
  const setStatus = useAction((v: { offerId: string; matchId: string; status: 'accepted' | 'declined' | 'completed' }) => api.updateMatch(v.offerId, v.matchId, v.status), { invalidate: (qc, _r, v) => invalidate(v!.offerId)(qc) });
  const rmMatch = useAction((v: { offerId: string; matchId: string }) => api.deleteMatch(v.offerId, v.matchId), { success: 'Match removed', invalidate: (qc, _r, v) => invalidate(v!.offerId)(qc) });
  const wd = useAction((o: Offer) => api.updateOffer(o.id, { status: 'withdrawn' }), { success: 'Offer withdrawn', invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.offers }) });

  const active = list.filter((o) => o.status === 'open' || o.status === 'matched');
  const needs = needsByCategory(cases.data ?? []);
  const maxNeed = Math.max(1, ...needs.map((n) => n.count));
  const allMatches = useMemo(() => list.flatMap((o) => (matchesBy.get(o.id) ?? []).map((m) => ({ o, m }))).filter((x) => x.m.status !== 'declined').sort((a, b) => Date.parse(b.m.created_at ?? '') - Date.parse(a.m.created_at ?? '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, matchQs.map((q) => q.dataUpdatedAt).join(',')]);
  const colors = ['var(--blue)', 'var(--red)', 'var(--orange)', 'var(--green)', 'var(--muted)'];

  return (
    <div className="view on">
      <div className="agrid">
        <div className="card">
          <div className="card-h"><h2>Offers from people marked safe</h2><Pill bg="var(--green-soft)" color="var(--green)">{active.length} offer{active.length === 1 ? '' : 's'}</Pill></div>
          {offers.isError && <ErrorBox error={offers.error} onRetry={() => void offers.refetch()} />}
          <div className="tbl-wrap">
            <table className="tbl" aria-label="Neighbor offers">
              <thead><tr><th>Offer</th><th>From</th><th>Area</th><th>Can help</th><th>Match</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {offers.isLoading && Array.from({ length: 3 }, (_, i) => <tr key={i}><td colSpan={6}><div className="skel" style={{ height: 34 }} /></td></tr>)}
                {list.filter((o) => o.status !== 'withdrawn').map((o) => {
                  const ms = (matchesBy.get(o.id) ?? []).filter((m) => m.status !== 'declined');
                  const m = ms[0];
                  return (
                    <tr key={o.id}>
                      <td><b>{o.description ?? KIND_LABEL[o.kind]}</b><p>{KIND_LABEL[o.kind]}{o.capacity ? `, capacity ${o.capacity}` : ''}</p></td>
                      <td>Resident<p>{o.sender_hash ? `#${o.sender_hash.slice(0, 5)}` : 'anonymous'}</p></td>
                      <td>~{(o.approx_location.radius_m / 1000).toFixed(1)} km area<p>{o.approx_location.lat.toFixed(2)}, {o.approx_location.lng.toFixed(2)}</p></td>
                      <td>{o.expires_at ? `Until ${formatDateTime(o.expires_at)}` : `Within ${o.radius_km ?? '?'} km`}<p>Posted {formatAge(o.created_at, now)}</p></td>
                      <td>
                        {m ? (<><span className={`st ${MATCH_CLASS[m.status]}`}>{MATCH_LABEL[m.status]}</span><p>{shortId(m.sos_id)} · {m.distance_km.toFixed(1)} km</p></>) : <span className="muted">No request nearby</span>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canAct && m && m.status === 'suggested' && <button className="claim" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ offerId: o.id, matchId: m.id, status: 'accepted' })}>Send match</button>}
                        {canAct && m && m.status === 'accepted' && <button className="claim blue" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ offerId: o.id, matchId: m.id, status: 'completed' })}>Mark delivered</button>}
                        {canAct && m && m.status === 'suggested' && <button className="claim ghost" style={{ marginLeft: 6 }} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ offerId: o.id, matchId: m.id, status: 'declined' })}>Decline</button>}
                        {canAct && m && m.status !== 'suggested' && m.status !== 'accepted' && <button className="claim ghost" onClick={() => rmMatch.mutate({ offerId: o.id, matchId: m.id })}>Remove</button>}
                        {canAct && !m && o.status === 'open' && <button className="claim ghost" onClick={() => setManual(o)}>Match…</button>}
                        {canAct && o.status === 'open' && <button className="btn link" onClick={() => setWithdraw(o)}>Withdraw</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!offers.isLoading && list.length === 0 && <Empty>No offers yet. People marked safe can offer help from the app.</Empty>}
        </div>
        <div className="card">
          <div className="card-h"><h2>What people are asking for</h2></div>
          <div className="needs">
            {needs.length === 0 && <Empty>No open requests.</Empty>}
            {needs.map((n, i) => (
              <div key={n.label}><span>{n.label}</span><div className="bar"><i style={{ width: `${(n.count / maxNeed) * 100}%`, background: colors[i % colors.length] }} /></div><b>{n.count}</b></div>
            ))}
          </div>
          <p className="note" style={{ padding: '0 18px 18px' }}>Counts are open cases by category. Matches are suggestions. A dispatcher approves each one before the neighbour is told where to go.</p>
        </div>
        <div className="card" style={{ gridColumn: 2 }}>
          <div className="card-h"><h2>Matches in progress</h2></div>
          <div className="mlist">
            {allMatches.length === 0 && <Empty>No matches yet.</Empty>}
            {allMatches.slice(0, 8).map(({ o, m }) => (
              <div className="mi" key={m.id}>
                <span className={`st ${MATCH_CLASS[m.status]}`}>{MATCH_LABEL[m.status]}</span>
                <div className="grow"><b>{o.description ?? KIND_LABEL[o.kind]} to {shortId(m.sos_id)}</b><p>{m.distance_km.toFixed(1)} km apart{m.created_at ? `. Matched ${formatAge(m.created_at, now)}` : ''}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {manual && <ManualMatch offer={manual} onClose={() => setManual(null)} />}
      {withdraw && <ConfirmDialog title="Withdraw this offer?" confirmLabel="Withdraw" busy={wd.isPending} body="It disappears from the open list and any suggested match is dropped." onClose={() => setWithdraw(null)} onConfirm={() => wd.mutate(withdraw, { onSuccess: () => setWithdraw(null) })} />}
    </div>
  );
}
