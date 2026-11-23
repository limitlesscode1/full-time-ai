
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

declare const Deno: any;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const ADMIN_ID = '43f9b97f-957f-4ab7-85fc-b43d4f6399a3';
const ALLOWED_ORIGIN = 'https://full-time-ai.onrender.com';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('Required Supabase environment variables are missing.');
}

const adminClient = createClient(
  SUPABASE_URL,
  SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
    }
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';

  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response('Origin not allowed', { status: 403 });
  }

  if (req.method === 'OPTIONS') {
    return response({ ok: true });
  }

  if (req.method !== 'POST') {
    return response({ error: 'Method not allowed' }, 405);
  }

  try {
    const authorization = req.headers.get('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();

    if (!token) {
      return response({ error: 'Authentication required' }, 401);
    }

    const userClient = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: authData, error: authError } =
      await userClient.auth.getUser(token);

    if (authError || !authData.user) {
      return response({ error: 'Invalid or expired session' }, 401);
    }

    if (authData.user.id !== ADMIN_ID) {
      return response({ error: 'Administrator access required' }, 403);
    }

    const { data: adminProfile, error: adminError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', ADMIN_ID)
      .maybeSingle();

    if (adminError || !adminProfile || adminProfile.role !== 'admin') {
      return response({ error: 'Administrator verification failed' }, 403);
    }

    const body = await req.json();

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response({ error: 'Invalid request body' }, 400);
    }

    const targetId = String(body.user_id || '');
    const action = String(body.action || '');

    const reason = typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : '';

    const validUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!validUuid.test(targetId)) {
      return response({ error: 'Invalid user ID' }, 400);
    }

    if (targetId === ADMIN_ID) {
      return response({ error: 'You cannot change your own admin status' }, 403);
    }

    if (!['ban', 'unban', 'lock', 'unlock'].includes(action)) {
      return response({ error: 'Invalid action' }, 400);
    }

    // Verify that the target exists and is not another administrator.
    const { data: targetProfile, error: targetError } = await adminClient
      .from('profiles')
      .select('id, role')
      .eq('id', targetId)
      .maybeSingle();

    if (targetError) {
      console.error('Target lookup failed:', targetError.message);
      return response({ error: 'Could not verify target account' }, 500);
    }

    if (!targetProfile) {
      return response({ error: 'User not found' }, 404);
    }

    if (targetProfile.role === 'admin') {
      return response({ error: 'Administrator accounts cannot be changed' }, 403);
    }

    let update: Record<string, unknown>;

    if (action === 'ban') {
      update = {
        status: 'banned',
        locked_until: null,
        status_reason: reason || null,
        updated_at: new Date().toISOString()
      };
    } else if (action === 'unban' || action === 'unlock') {
      update = {
        status: 'active',
        locked_until: null,
        status_reason: null,
        updated_at: new Date().toISOString()
      };
    } else {
      let lockedUntil: string | null = null;

      if (
        body.locked_until !== undefined &&
        body.locked_until !== null &&
        body.locked_until !== ''
      ) {
        if (typeof body.locked_until !== 'string') {
          return response({ error: 'Invalid lock expiry' }, 400);
        }

        const parsed = Date.parse(body.locked_until);

        if (!Number.isFinite(parsed) || parsed <= Date.now()) {
          return response({ error: 'Lock expiry must be a future date' }, 400);
        }

        lockedUntil = new Date(parsed).toISOString();
      }

      update = {
        status: 'locked',
        locked_until: lockedUntil,
        status_reason: reason || null,
        updated_at: new Date().toISOString()
      };
    }

    const { data: updatedUser, error: updateError } = await adminClient
      .from('profiles')
      .update(update)
      .eq('id', targetId)
      .neq('role', 'admin')
      .select('id, status, locked_until, status_reason')
      .maybeSingle();

    if (updateError) {
      console.error('Admin status update failed:', updateError.message);
      return response({ error: 'Could not update user status' }, 500);
    }

    if (!updatedUser) {
      return response({ error: 'User could not be updated' }, 403);
    }

    return response({
      ok: true,
      message: 'User status updated',
      user: updatedUser
    });

  } catch (error) {
    console.error('Admin function error:', error);
    return response({ error: 'Unexpected server error' }, 500);
  }
});
