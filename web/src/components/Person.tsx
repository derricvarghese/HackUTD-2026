import type { ReactNode } from 'react';
import type { ProfileFull, ProfilePublic, Sos, SosDetail } from '../api/models';
import {
  FLAG_META, LOCKED_TEXT, ageChip, ageLabel, displayName, hasAny, needLabel, personAccess, petsLabel, sortFlags, telHref, unlockedReason,
} from '../lib/profile';
import { IcLock } from './icons';
import { useAuth, useCanAct, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';

/** Small chips for the coarse vulnerability flags. Each has a visible short label, a tooltip and an accessible full label. */
export function FlagChips({ flags, max }: { flags: ProfilePublic['vulnerability_flags'] | undefined; max?: number }) {
  const list = sortFlags(flags);
  if (!list.length) return null;
  const shown = max ? list.slice(0, max) : list;
  const rest = list.length - shown.length;
  return (
    <span className="pflags" role="list" aria-label="Vulnerability flags">
      {shown.map((f) => (
        <span role="listitem" key={f} className={`pflag f-${f}`} title={FLAG_META[f].tip}>
          <span aria-hidden="true">{FLAG_META[f].short}</span>
          <span className="sr-only">{FLAG_META[f].label}</span>
        </span>
      ))}
      {rest > 0 && (
        <span role="listitem" className="pflag more" title={list.slice(max).map((f) => FLAG_META[f].label).join(', ')}>
          <span aria-hidden="true">+{rest}</span>
          <span className="sr-only">and {rest} more: {list.slice(max).map((f) => FLAG_META[f].label).join(', ')}</span>
        </span>
      )}
    </span>
  );
}

export function AgeChip({ age }: { age: ProfilePublic['age_range'] }) {
  const t = ageChip(age);
  if (!t) return null;
  return (
    <span className="pchip" title={ageLabel(age) ?? undefined}>
      <span aria-hidden="true">{t}</span>
      <span className="sr-only">{ageLabel(age)}</span>
    </span>
  );
}

/** Name + age chip + flags: the identity line used on queue cards, table rows, map list and search results. */
export function PersonLine({ profile, maxFlags = 4, showHint = true, block = false }: { profile: ProfilePublic | null | undefined; maxFlags?: number; showHint?: boolean; block?: boolean }) {
  const d = displayName(profile);
  return (
    <div className={`pline${block ? ' blk' : ''}`} data-testid="person-line">
      <span className={`pname${d.known ? '' : ' unk'}`} title={d.preferred ? `${d.primary} “${d.preferred}”` : d.primary}>
        {d.primary}
        {d.preferred && <span className="pref"> {'“'}{d.preferred}{'”'}</span>}
      </span>
      {profile && <AgeChip age={profile.age_range} />}
      {profile && <FlagChips flags={profile.vulnerability_flags} max={maxFlags} />}
      {showHint && d.hint && <span className="phint">{d.hint}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prow">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const toast = useUi((s) => s.toast);
  return (
    <button
      type="button"
      className="btn sm copy"
      aria-label={`Copy ${what}`}
      onClick={() => {
        const done = () => toast('success', `${what[0].toUpperCase()}${what.slice(1)} copied`);
        const fail = () => toast('error', 'Could not copy. Select the text and copy it manually.');
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fail);
        else fail();
      }}
    >
      Copy
    </button>
  );
}

function Phone({ phone, what }: { phone: string; what: string }) {
  const href = telHref(phone);
  return (
    <span className="pphone">
      {href ? <a href={href} aria-label={`Call ${what} ${phone}`}>{phone}</a> : phone}
      <CopyButton text={phone} what={what} />
    </span>
  );
}

const List = ({ items }: { items: string[] | undefined }) => (items?.length ? <>{items.join(', ')}</> : null);

function FullDetails({ p }: { p: ProfileFull }) {
  const m = p.medical;
  const mob = p.mobility;
  const hh = p.household;
  const ap = p.appearance;
  const ec = p.emergency_contact;
  const pets = petsLabel(hh?.pets);
  return (
    <div className="pfull" data-testid="profile-full">
      <section className="psec" aria-label="Identity">
        <h4>Identity</h4>
        <dl>
          {p.preferred_name && <Row label="Preferred name">{p.preferred_name}</Row>}
          {p.birth_year && <Row label="Born">{p.birth_year}{p.age_range ? ` (age ${p.age_range})` : ''}</Row>}
          {p.phone && <Row label="Phone"><Phone phone={p.phone} what="phone number" /></Row>}
          {!!p.languages?.length && <Row label="Languages"><List items={p.languages} /></Row>}
        </dl>
      </section>
      {hasAny(ap) && (
        <section className="psec" aria-label="Appearance">
          <h4>Appearance</h4>
          <dl>
            {ap?.height_cm && <Row label="Height">{ap.height_cm} cm</Row>}
            {ap?.hair && <Row label="Hair">{ap.hair}</Row>}
            {ap?.clothing && <Row label="Clothing">{ap.clothing}</Row>}
            {ap?.distinguishing_marks && <Row label="Distinguishing marks">{ap.distinguishing_marks}</Row>}
          </dl>
        </section>
      )}
      {hasAny(m) && (
        <section className="psec med" aria-label="Medical">
          <h4>Medical</h4>
          <dl>
            {!!m?.conditions?.length && <Row label="Conditions"><List items={m.conditions} /></Row>}
            {!!m?.medications?.length && <Row label="Medications"><List items={m.medications} /></Row>}
            {!!m?.allergies?.length && <Row label="Allergies"><b className="redt"><List items={m.allergies} /></b></Row>}
            {m?.blood_type && m.blood_type !== 'unknown' && <Row label="Blood type"><b>{m.blood_type}</b></Row>}
          </dl>
        </section>
      )}
      {hasAny(mob) && (
        <section className="psec" aria-label="Mobility">
          <h4>Mobility</h4>
          <dl>
            {!!mob?.needs?.length && <Row label="Needs">{mob.needs.map(needLabel).join(', ')}</Row>}
            {mob?.notes && <Row label="Notes">{mob.notes}</Row>}
          </dl>
        </section>
      )}
      {(hasAny(hh) || pets) && (
        <section className="psec" aria-label="Household">
          <h4>Household</h4>
          <dl>
            {hh?.people_count !== undefined && <Row label="People at home">{hh.people_count}{hh.children ? `, ${hh.children} ${hh.children === 1 ? 'child' : 'children'}` : ''}{hh.elderly ? `, ${hh.elderly} elderly` : ''}</Row>}
            {pets && <Row label="Pets">{pets}</Row>}
          </dl>
        </section>
      )}
      {p.home_address && (
        <section className="psec" aria-label="Home address">
          <h4>Home address</h4>
          <p className="paddr">{p.home_address} <CopyButton text={p.home_address} what="address" /></p>
        </section>
      )}
      {ec && (
        <section className="psec" aria-label="Emergency contact">
          <h4>Emergency contact</h4>
          <dl>
            <Row label="Name">{ec.name}{ec.relationship ? ` (${ec.relationship})` : ''}</Row>
            <Row label="Phone"><Phone phone={ec.phone} what="emergency contact phone" /></Row>
          </dl>
        </section>
      )}
      {p.notes && (
        <section className="psec" aria-label="Profile notes">
          <h4>Notes</h4>
          <p className="pnotes">{p.notes}</p>
        </section>
      )}
      {p.synthetic && <p className="note">Synthetic demo data.</p>}
    </div>
  );
}

/** Top of the case panel. Locked state shows nothing beyond the public view; details render only when the API returned `profile_full`. */
export function PersonSection({ c }: { c: Sos & Partial<SosDetail> }) {
  const canAct = useCanAct();
  const isAdmin = useIsAdmin();
  const me = useAuth((s) => s.responder?.id);
  const access = personAccess(c, canAct, me);
  const a = c.assignment;
  const assignedToMe = !!a && ['assigned', 'en_route', 'on_scene'].includes(a.status) && a.responder_id === me;
  const d = displayName(c.profile);
  return (
    <section className="sd-sec person" aria-label="Person" data-access={access}>
      <div className="person-head">
        <h3>Person</h3>
        {access === 'unlocked' && <span className="pbadge" title="Sensitive personal data">Private</span>}
      </div>
      <PersonLine profile={c.profile} maxFlags={7} showHint={false} block />
      {d.hint && <p className="phint">{d.hint}</p>}
      {access === 'unlocked' && c.profile_full && (
        <>
          <div className="priv ok" role="note">{unlockedReason(isAdmin, assignedToMe)} Handle with care and do not share outside the response.</div>
          <FullDetails p={c.profile_full} />
        </>
      )}
      {(access === 'locked_claim' || access === 'locked_volunteer' || access === 'locked_other') && (
        <div className="plock" role="note">
          <IcLock width={18} height={18} className="plock-ic" />
          <span>{LOCKED_TEXT[access]}</span>
        </div>
      )}
    </section>
  );
}
