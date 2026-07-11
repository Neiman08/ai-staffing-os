import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, Loader2, MapPin, Users2 } from "lucide-react";
import type { PublicJobOpening } from "@ai-staffing-os/shared";
import { useSeo } from "@/lib/seo";
import { publicApiFetch, PublicApiError } from "@/lib/api";
import { Section, Eyebrow } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Label, Input, Select } from "@/components/ui/Field";

interface ApplyForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  yearsExperience: string;
  categoryName: string;
  smsOptIn: boolean;
}

const EMPTY: ApplyForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  city: "",
  state: "",
  yearsExperience: "",
  categoryName: "",
  smsOptIn: false,
};

export default function Careers() {
  useSeo({
    title: "Careers",
    description: "Browse current openings and apply — a real recruiter reviews every application.",
    path: "/careers",
  });

  const [openings, setOpenings] = useState<PublicJobOpening[] | null>(null);
  const [form, setForm] = useState<ApplyForm>(EMPTY);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    publicApiFetch<PublicJobOpening[]>("/job-openings")
      .then(setOpenings)
      .catch(() => setOpenings([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      await publicApiFetch("/apply", {
        method: "POST",
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone || undefined,
          city: form.city || undefined,
          state: form.state ? form.state.toUpperCase() : undefined,
          yearsExperience: form.yearsExperience || undefined,
          categoryName: form.categoryName || undefined,
          smsOptIn: form.smsOptIn,
        }),
      });
      setStatus("success");
      setForm(EMPTY);
    } catch (err) {
      setStatus("error");
      setError(err instanceof PublicApiError ? err.message : "Something went wrong. Please try again.");
    }
  }

  return (
    <>
      <Section tone="ink" className="pt-28">
        <div className="max-w-2xl">
          <Eyebrow>Careers</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">Find your next role</h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            Browse current openings below, or apply directly — we'll match you against active roles that fit your
            experience.
          </p>
        </div>
      </Section>

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Current Openings</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Active roles</h2>
        </div>
        {openings === null ? (
          <p className="text-center text-sm text-muted-foreground">Loading openings…</p>
        ) : openings.length === 0 ? (
          <p className="mx-auto max-w-md text-center text-sm text-muted-foreground">
            We don't have any published openings right now — apply below and we'll reach out as soon as a matching
            role comes in.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {openings.map((job) => (
              <div key={job.id} className="rounded-xl border border-border bg-card p-6">
                <p className="text-xs font-semibold uppercase tracking-widest text-primary">{job.industryName}</p>
                <h3 className="mt-2 font-semibold">{job.title}</h3>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" />
                    {job.city && job.state ? `${job.city}, ${job.state}` : "Multiple locations"}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users2 className="h-3.5 w-3.5" />
                    {job.workersNeeded} position{job.workersNeeded === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section tone="muted">
        <div className="mx-auto max-w-xl">
          <div className="mb-10 text-center">
            <Eyebrow>Apply</Eyebrow>
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Submit your application</h2>
          </div>
          {status === "success" ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-10 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary" />
              <h2 className="text-xl font-semibold">Application received</h2>
              <p className="text-sm text-muted-foreground">
                Thanks for applying — a recruiter will review your application and follow up if there's a fit.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName" required>
                    First name
                  </Label>
                  <Input
                    id="firstName"
                    required
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="lastName" required>
                    Last name
                  </Label>
                  <Input
                    id="lastName"
                    required
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="email" required>
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="city">City</Label>
                  <Input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="state">State</Label>
                  <Input
                    id="state"
                    maxLength={2}
                    placeholder="IL"
                    value={form.state}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="yearsExperience">Years of experience</Label>
                  <Input
                    id="yearsExperience"
                    type="number"
                    min={0}
                    max={60}
                    value={form.yearsExperience}
                    onChange={(e) => setForm({ ...form, yearsExperience: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="categoryName">Trade / role</Label>
                  <Select
                    id="categoryName"
                    value={form.categoryName}
                    onChange={(e) => setForm({ ...form, categoryName: e.target.value })}
                  >
                    <option value="">Select if applicable</option>
                    <option value="Electrician">Electrician</option>
                    <option value="HVAC Technician">HVAC Technician</option>
                    <option value="Warehouse Associate">Warehouse Associate</option>
                    <option value="Forklift Operator">Forklift Operator</option>
                    <option value="General Laborer">General Laborer</option>
                    <option value="Machine Operator">Machine Operator</option>
                  </Select>
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.smsOptIn}
                  onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })}
                />
                I agree to receive text messages about my application.
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" size="lg" disabled={status === "submitting"} className="w-full">
                {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                Submit Application
              </Button>
            </form>
          )}
        </div>
      </Section>
    </>
  );
}
