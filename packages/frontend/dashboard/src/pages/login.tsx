import { Navigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";

export function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();
  const [email, setEmail] = useState("");

  if (isLoading) {
    return (
      <main className="min-h-screen text-foreground">
        <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6 py-6">
          <p className="text-sm text-muted-foreground">Checking session...</p>
        </div>
      </main>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" />;
  }

  return (
    <main className="min-h-screen text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6 py-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="mb-6 text-2xl font-bold">FilePipeline</p>
          <h1 className="mb-2 text-2xl font-semibold">ETL Monitoring</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            Continue to the secure sign-in page to access dashboard metrics.
          </p>

          <form
            className="space-y-6 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void login({ loginHint: email });
            }}
          >
            <Field>
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
              />
              <FieldDescription>
                Your password will be entered on the Cognito sign-in page.
              </FieldDescription>
            </Field>

            <Button type="submit" className="w-full justify-center" size="default">
              Continue to Sign In
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
