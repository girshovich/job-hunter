# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-magic-link.spec.ts >> magic-link login (GET /welcome/verify) >> clicking magic link logs in and lands on dashboard
- Location: tests/auth-magic-link.spec.ts:27:7

# Error details

```
Error: apiRequestContext.post: Only one of 'data', 'form' or 'multipart' can be specified
```