-- Warnings and criticals a review's lenses or feedback held back, kept on the row so a review of the
-- same head asked for again (which clears the report) does not forget them. Auto-approval refuses
-- while any review of the pull request held one back. Metadata-only: a constant default.
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "held_back" integer NOT NULL DEFAULT 0;
