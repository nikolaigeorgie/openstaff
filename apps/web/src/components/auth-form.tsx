"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { login, signup, type FormState } from "@/app/actions";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "login" ? login : signup, undefined);
  const [timezone, setTimezone] = useState("America/New_York");
  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return (
    <form action={action} className="space-y-4">
      {mode === "signup" && (
        <>
          <div>
            <label className="label" htmlFor="company">Company name</label>
            <input className="input" id="company" name="company" required defaultValue={state?.values?.company} autoComplete="organization" />
          </div>
          <div>
            <label className="label" htmlFor="name">Your name</label>
            <input className="input" id="name" name="name" required defaultValue={state?.values?.name} autoComplete="name" />
          </div>
          <input type="hidden" name="timezone" value={timezone} />
        </>
      )}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" required defaultValue={state?.values?.email} autoComplete="email" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 8 : undefined}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </div>
      {state?.error && <p className="text-sm text-weak" role="alert">{state.error}</p>}
      <button className="btn w-full" disabled={pending}>
        {pending ? "One moment…" : mode === "login" ? "Log in" : "Create account"}
      </button>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          <>New here? <Link className="text-accent underline" href="/signup">Create an account</Link></>
        ) : (
          <>Already have an account? <Link className="text-accent underline" href="/login">Log in</Link></>
        )}
      </p>
    </form>
  );
}
