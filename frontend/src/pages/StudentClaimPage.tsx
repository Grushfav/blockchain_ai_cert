import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  GraduationCap,
  Mail,
  Wallet,
  Hash,
  ShieldCheck,
} from "lucide-react";

import { apiJson } from "../api/client";
import { BusyLabel } from "../components/LoadingSpinner";

type VerifiedUni = {
  id: number;
  name: string;
  internal_id: string;
  logo_url?: string | null;
};

export function StudentClaimPage() {

  const [universities, setUniversities] =
    useState<VerifiedUni[]>([]);

  const [uniBusy, setUniBusy] =
    useState(true);

  const [uniErr, setUniErr] =
    useState<string | null>(null);

  const [universityId, setUniversityId] =
    useState("");

  const [studentInternalId, setStudentInternalId] =
    useState("");

  const [email, setEmail] =
    useState("");

  const [wallet, setWallet] =
    useState("");

  const [submitBusy, setSubmitBusy] =
    useState(false);

  const [submitErr, setSubmitErr] =
    useState<string | null>(null);

  const [submitOk, setSubmitOk] =
    useState<string | null>(null);

  useEffect(() => {

    let cancelled = false;

    (async () => {

      setUniBusy(true);
      setUniErr(null);

      try {

        const data = await apiJson<{
          universities: VerifiedUni[];
        }>(
          "/api/public/verified-universities"
        );

        if (!cancelled) {
          setUniversities(
            data.universities || []
          );
        }

      } catch (caught: unknown) {

        if (!cancelled) {
          setUniErr(
            caught instanceof Error
              ? caught.message
              : "Failed to load institutions"
          );
        }

      } finally {

        if (!cancelled) {
          setUniBusy(false);
        }

      }

    })();

    return () => {
      cancelled = true;
    };

  }, []);

  async function onSubmit(
    e: React.FormEvent
  ) {

    e.preventDefault();

    setSubmitErr(null);
    setSubmitOk(null);

    const uid = Number(universityId);

    if (!Number.isInteger(uid) || uid < 1) {
      setSubmitErr(
        "Please choose your institution."
      );

      return;
    }

    setSubmitBusy(true);

    try {

      const out = await apiJson<{
        message?: string;
        id?: number;
      }>(
        "/api/public/student-claim-requests",
        {
          method: "POST",

          json: {
            university_id: uid,
            student_internal_id:
              studentInternalId.trim(),
            student_email:
              email.trim(),
            wallet_address:
              wallet.trim(),
          },
        }
      );

      setSubmitOk(
        out.message ||
        "Your request has been submitted successfully."
      );

      setWallet("");

    } catch (caught: unknown) {

      setSubmitErr(
        caught instanceof Error
          ? caught.message
          : "Request failed"
      );

    } finally {

      setSubmitBusy(false);

    }
  }

  return (

    <div className="verify-page verify-page--mock">

      {/* HERO */}

      <header className="verify-mock-hero">

        <p className="verify-mock-hero__top">
          Students
        </p>

        <h1 className="verify-mock-hero__title">
          Claim Digital Certificate
        </h1>

        <p className="verify-mock-hero__lead">
          If your institution has issued your
          credential, submit your details below
          to securely receive access to your
          verified digital certificate.
        </p>

      </header>

      {/* FORM PANEL */}

      <section className="verify-mock-panel">

        <div className="verify-mock-panel__head">

          <h2 className="verify-mock-panel__title">
            Credential Request Form
          </h2>

          <p className="verify-mock-panel__hint muted-inline small">
            Use the same student ID and email
            registered with your institution.
          </p>

        </div>

        {uniBusy ? (

          <p className="muted-inline">
            Loading institutions…
          </p>

        ) : uniErr ? (

          <div className="error">
            {uniErr}
          </div>

        ) : (

          <form
            className="verify-form--mock stack"
            onSubmit={(e) => void onSubmit(e)}
          >

            {/* INSTITUTION */}

            <div className="inst-field">

              <label htmlFor="claim-uni">
                Institution
              </label>

              <div className="inst-input-wrap">

                <span
                  className="inst-input-icon"
                  aria-hidden
                >
                  <GraduationCap />
                </span>

                <select
                  id="claim-uni"
                  value={universityId}
                  onChange={(e) =>
                    setUniversityId(
                      e.target.value
                    )
                  }
                  required
                >

                  <option value="">
                    Select Institution
                  </option>

                  {universities.map((u) => (

                    <option
                      key={u.id}
                      value={String(u.id)}
                    >
                      {u.name}
                    </option>

                  ))}

                </select>

              </div>

            </div>

            {/* STUDENT ID */}

            <div className="inst-field">

              <label htmlFor="claim-sid">
                Student ID
              </label>

              <div className="inst-input-wrap">

                <span
                  className="inst-input-icon"
                  aria-hidden
                >
                  <Hash />
                </span>

                <input
                  id="claim-sid"
                  value={studentInternalId}
                  onChange={(e) =>
                    setStudentInternalId(
                      e.target.value
                    )
                  }
                  autoComplete="username"
                  placeholder="Enter your student ID"
                  required
                />

              </div>

            </div>

            {/* EMAIL */}

            <div className="inst-field">

              <label htmlFor="claim-email">
                Email Address
              </label>

              <div className="inst-input-wrap">

                <span
                  className="inst-input-icon"
                  aria-hidden
                >
                  <Mail />
                </span>

                <input
                  id="claim-email"
                  type="email"
                  value={email}
                  onChange={(e) =>
                    setEmail(
                      e.target.value
                    )
                  }
                  autoComplete="email"
                  placeholder="Enter your email"
                  required
                />

              </div>

            </div>

            {/* WALLET */}

            <div className="inst-field">

              <label htmlFor="claim-wallet">
                Wallet Address
              </label>

              <div className="inst-input-wrap">

                <span
                  className="inst-input-icon"
                  aria-hidden
                >
                  <Wallet />
                </span>

                <input
                  id="claim-wallet"
                  className="mono"
                  value={wallet}
                  onChange={(e) =>
                    setWallet(
                      e.target.value
                    )
                  }
                  placeholder="0x..."
                  autoComplete="off"
                  required
                />

              </div>

            </div>

            {/* ERRORS */}

            {submitErr && (
              <div className="error">
                {submitErr}
              </div>
            )}

            {/* SUCCESS */}

            {submitOk && (
              <div className="success">
                {submitOk}
              </div>
            )}

            {/* SUBMIT */}

            <button
              type="submit"
              disabled={submitBusy}
              aria-busy={submitBusy}
            >

              <BusyLabel
                busy={submitBusy}
                idle="Request Credential Access"
                busyLabel="Submitting..."
              />

            </button>

          </form>

        )}

        {/* FOOTER LINKS */}

        <p
          className="muted-inline small verify-mock-footer"
          style={{ marginTop: "1rem" }}
        >

          <Link to="/verify">
            Verify a Credential
          </Link>

          {" · "}

          <Link to="/">
            Home
          </Link>

        </p>

      </section>

      {/* SECURITY NOTES */}

      <section className="verify-mock-panel verify-mock-panel--muted">

        <div className="verify-security-header">

          <ShieldCheck
            className="verify-security-icon"
          />

          <h3 className="verify-mock-panel__title verify-mock-panel__title--inline">
            Your Security & Privacy
          </h3>

        </div>

        <ul
          className="muted-inline small"
          style={{
            margin: "0.75rem 0 0",
            paddingLeft: "1.1rem",
          }}
        >

          <li>
            Your information is securely
            reviewed by your institution
            before approval.
          </li>

          <li>
            Only verified institutions can
            approve credential requests.
          </li>

          <li>
            Never share your wallet recovery
            phrase or private keys with anyone.
          </li>

        </ul>

      </section>

    </div>
  );
}