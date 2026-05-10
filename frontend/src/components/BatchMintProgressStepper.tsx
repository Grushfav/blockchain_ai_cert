type BatchMintProgressStepperProps = {
  prepared: boolean;
  signed: boolean;
  executed: boolean;
  prepareBusy?: boolean;
  signBusy?: boolean;
  executeBusy?: boolean;
};

const STEPS = [
  { id: "prepared", title: "Prepare all rows", hint: "Server pins metadata + index" },
  { id: "signed", title: "Sign batch EIP-712", hint: "In your wallet · batch auth · no gas" },
  { id: "executed", title: "Platform submits mints", hint: "One on-chain tx per row" },
] as const;

export function BatchMintProgressStepper({
  prepared,
  signed,
  executed,
  prepareBusy,
  signBusy,
  executeBusy,
}: BatchMintProgressStepperProps) {
  const flags = [prepared, signed, executed] as const;
  const busy = [prepareBusy, signBusy, executeBusy];

  let consecutiveDone = 0;
  for (const f of flags) {
    if (f) consecutiveDone += 1;
    else break;
  }

  const firstOpen = flags.findIndex((f) => !f);
  const allDone = consecutiveDone === 3;

  return (
    <div className="batch-mint-flow-wrap" role="region" aria-label="Batch mint progress">
      <p className="batch-mint-flow-wrap__label muted-inline small">Progress on this batch</p>
      <ol className="uni-flow-steps batch-mint-flow">
        {STEPS.map((s, i) => {
          const done = flags[i];
          const current = !allDone && firstOpen === i;
          const upcoming = !allDone && firstOpen !== -1 && i > firstOpen;
          const state = done ? "done" : current ? "current" : upcoming ? "upcoming" : "done";
          const isBusy = Boolean(busy[i]) && current;
          return (
            <li
              key={s.id}
              className={`uni-flow-steps__item uni-flow-steps__item--batch-${state} batch-mint-flow__step`}
            >
              <span className="batch-mint-flow__badge" aria-current={current ? "step" : undefined}>
                {done ? (
                  <span className="batch-mint-flow__check" aria-hidden>
                    ✓
                  </span>
                ) : isBusy ? (
                  <span className="batch-mint-flow__spinner" aria-hidden />
                ) : (
                  <span className="batch-mint-flow__num" aria-hidden>
                    {i + 1}
                  </span>
                )}
              </span>
              <span className="batch-mint-flow__text">
                <span className="batch-mint-flow__title">{s.title}</span>
                <span className="batch-mint-flow__hint">{s.hint}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
