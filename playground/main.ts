import { AdminSchema, EmailSchema, PostSchema, UserSchema } from './schemas';
import { toJsonSchema } from '@valibot/to-json-schema';


const email = toJsonSchema(EmailSchema, { target: 'draft-2020-12' });
const user = toJsonSchema(UserSchema);
const admin = toJsonSchema(AdminSchema);
const post = toJsonSchema(PostSchema);


document.getElementById('app')!.innerHTML = [email, user, admin, post].map(val => (`<pre>${JSON.stringify(val, null, 2)}</pre>`)).join('\n');
