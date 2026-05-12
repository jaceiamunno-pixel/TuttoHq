export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error_description ?? "Token refresh failed")
  }
  return res.json()
}

export async function setupWatch(accessToken: string): Promise<{ historyId: string; expiration: string }> {
  const topic = process.env.GOOGLE_PUBSUB_TOPIC
  if (!topic) throw new Error("GOOGLE_PUBSUB_TOPIC not configured")

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labelIds: ["INBOX"], topicName: topic }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message ?? "Watch setup failed")
  }
  return res.json()
}

// Returns a valid access token, refreshing if needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getValidToken(supabase: any, userId: string): Promise<string> {
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("access_token, refresh_token, token_expiry")
    .eq("user_id", userId)
    .single()

  if (!conn) throw new Error("No Gmail connection found")

  const expiresAt = new Date(conn.token_expiry as string).getTime()
  if (Date.now() + 5 * 60 * 1000 < expiresAt) {
    return conn.access_token as string
  }

  const tokens = await refreshAccessToken(conn.refresh_token as string)
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  await supabase
    .from("gmail_connections")
    .update({ access_token: tokens.access_token, token_expiry: newExpiry })
    .eq("user_id", userId)

  return tokens.access_token
}
