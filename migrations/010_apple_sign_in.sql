-- Sign in with Apple: the account's Apple user id. Apple sends the e-mail only when the person shares it, so later
-- sign-ins find the account by this id.
alter table users add column apple_sub text unique;
