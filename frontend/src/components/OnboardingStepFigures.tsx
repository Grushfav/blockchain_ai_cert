export type OnboardingFigure = {
  src: string;
  alt: string;
  caption?: string;
};

type Props = {
  figures: OnboardingFigure[];
};

export function OnboardingStepFigures({ figures }: Props) {
  if (!figures.length) return null;
  return (
    <div
      className={`onboarding-step__figures${figures.length > 1 ? " onboarding-step__figures--multi" : ""}`}
      aria-label="Step screenshots"
    >
      {figures.map((f) => (
        <figure key={f.src + f.alt} className="onboarding-step__figure">
          <img src={f.src} alt={f.alt} loading="lazy" className="onboarding-step__img" />
          {f.caption ? <figcaption className="onboarding-step__caption">{f.caption}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}
