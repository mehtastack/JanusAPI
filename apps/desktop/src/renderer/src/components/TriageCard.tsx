import { causeCount, failedTotals, type TriageCard as Card } from '@apijanus/agent/src/triage';

const STATUS: Record<Card['causes'][number]['status'], string> = { fixed: 'Fixed', 'needs-you': 'Needs you', unfixed: 'Not fixed', unknown: 'Unknown' };

/** A run's triage: totals before and after, then each cause with its requests, fix and status (in words). */
export function TriageCard({ card, names, onOpen }: { card: Card; names: Record<string, string>; onOpen(id: string): void }) {
  return (
    <section className="triage-card" role="region" aria-label="Triage">
      <p className="triage-totals">
        {`${causeCount(card)} · ${failedTotals(card)}`}
      </p>
      {card.stopped && <p className="muted">The run was stopped before it finished.</p>}
      {card.fallback && <p className="muted">Grouped from the run results.</p>}
      <ul className="triage-causes">
        {card.causes.map((c, n) => (
          <li key={n} className="triage-cause">
            <p className="triage-title">{`${c.title} · ${c.requestIds.length} ${c.requestIds.length === 1 ? 'request' : 'requests'}`}</p>
            <p className={`triage-status ${c.status}`}>{STATUS[c.status]}</p>
            {c.fix && <p className="triage-fix">{c.fix}</p>}
            <ul className="triage-requests">
              {c.requestIds.map((id) => <li key={id}><button type="button" className="link" onClick={() => onOpen(id)}>{names[id] ?? id}</button></li>)}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
