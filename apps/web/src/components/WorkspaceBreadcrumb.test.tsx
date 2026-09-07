import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";

describe("WorkspaceBreadcrumb", () => {
  it("renders a trailing action outside the semantic breadcrumb list", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        trailingAction={<button aria-label="Open parent conversation">Parent</button>}
      >
        <WorkspaceBreadcrumbItem>Project</WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>Child thread</WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>,
    );

    expect(markup).toContain('aria-label="Thread breadcrumb"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toMatch(
      /<\/ol><div data-workspace-breadcrumb-trailing-action="true"[^>]*><button aria-label="Open parent conversation">/,
    );
  });

  it("does not change breadcrumbs without a trailing action", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
        <WorkspaceBreadcrumbItem current>Settings</WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>,
    );

    expect(markup).not.toContain("data-workspace-breadcrumb-trailing-action");
    expect(markup).not.toContain("flex items-center");
  });
});
