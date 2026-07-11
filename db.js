import { sb, state } from './core.js';

// ===================== data access =====================
const SEL = '*, profiles!posts_user_id_fkey(username, avatar), likes(count), comments(count)';
const db = {
    // ---- feed (paginated via range) ----
    feed: (from = 0, to = 11) => sb.from('posts').select(SEL)
        .order('created_at', { ascending: false }).range(from, to),
    feedByUsers: (ids, from = 0, to = 11) => sb.from('posts').select(SEL)
        .in('user_id', ids).order('created_at', { ascending: false }).range(from, to),
    post: (id) => sb.from('posts').select(SEL).eq('id', id).single(),

    // ---- likes ----
    myLikes: () => sb.from('likes').select('post_id').eq('user_id', state.me.id),
    like:   (postId) => sb.from('likes').insert({ post_id: postId, user_id: state.me.id }),
    unlike: (postId) => sb.from('likes').delete().match({ post_id: postId, user_id: state.me.id }),
    likers: (postId) => sb.from('likes').select('profiles(username, avatar)')
        .eq('post_id', postId).order('created_at').limit(60),

    // ---- comments ----
    comments: (postId) => sb.from('comments').select('*, profiles(username)')
        .eq('post_id', postId).order('created_at').limit(100),
    addComment: (postId, body) => sb.from('comments')
        .insert({ post_id: postId, user_id: state.me.id, body }).select('*, profiles(username)').single(),
    delComment: (id) => sb.from('comments').delete().eq('id', id),

    // ---- posts ----
    addPost: (row) => sb.from('posts').insert(row).select().single(),
    delPost: (id) => sb.from('posts').delete().eq('id', id),
    postsBy: (userId) => sb.from('posts').select('*').eq('user_id', userId).order('created_at', { ascending: false }),

    // ---- profiles ----
    profile: (username) => sb.from('profiles').select('*').eq('username', username).single(),
    updateProfile: (patch) => sb.from('profiles').update(patch).eq('id', state.me.id),
    allProfiles:    () => sb.from('profiles').select('id, username, avatar, is_private').order('created_at', { ascending: false }).limit(50),
    searchProfiles: (q) => sb.from('profiles').select('id, username, avatar, is_private').ilike('username', `%${q}%`).limit(30),
    counts: (userId) => Promise.all([
        sb.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        sb.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', userId).eq('status', 'accepted'),
        sb.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', userId).eq('status', 'accepted'),
    ]),

    // ---- follows (with request status) ----
    follow:   (userId, isPrivate) => sb.from('follows').insert({ follower_id: state.me.id, following_id: userId, status: isPrivate ? 'pending' : 'accepted' }),
    unfollow: (userId) => sb.from('follows').delete().match({ follower_id: state.me.id, following_id: userId }),
    followState: (userId) => sb.from('follows').select('status').match({ follower_id: state.me.id, following_id: userId }).maybeSingle(),
    followsMe:   (userId) => sb.from('follows').select('follower_id', { head: true, count: 'exact' })
        .match({ follower_id: userId, following_id: state.me.id, status: 'accepted' }),
    myFollowing: () => sb.from('follows').select('following_id').eq('follower_id', state.me.id).eq('status', 'accepted'),
    myFollowers: () => sb.from('follows').select('follower_id').eq('following_id', state.me.id).eq('status', 'accepted'),
    pendingRequests: () => sb.from('follows').select('follower_id, created_at, actor:follower_id(username, avatar)')
        .eq('following_id', state.me.id).eq('status', 'pending').order('created_at', { ascending: false }),
    approveFollow: (followerId) => sb.from('follows').update({ status: 'accepted' }).match({ follower_id: followerId, following_id: state.me.id }),
    denyFollow:    (followerId) => sb.from('follows').delete().match({ follower_id: followerId, following_id: state.me.id }),

    // ---- notifications ----
    notifications: () => sb.from('notifications').select('*, actor:actor_id(username, avatar), post:post_id(preview)')
        .eq('recipient_id', state.me.id).order('created_at', { ascending: false }).limit(50),
    unreadCount: () => sb.from('notifications').select('id', { count: 'exact', head: true })
        .eq('recipient_id', state.me.id).eq('read', false),
    markAllRead: () => sb.from('notifications').update({ read: true }).eq('recipient_id', state.me.id).eq('read', false),
    // fire-and-forget; never notify yourself
    notify: (recipient, type, postId = null) => recipient === state.me.id
        ? Promise.resolve()
        : sb.from('notifications').insert({ recipient_id: recipient, actor_id: state.me.id, type, post_id: postId }),

    // ---- groups (persistent named group chats + calls) ----
    createGroup: async (name, memberIds) => {
        const { data: g, error } = await sb.from('groups').insert({ name, created_by: state.me.id }).select().single();
        if (error) return { error };
        const rows = [...new Set([state.me.id, ...memberIds])].map(uid => ({ group_id: g.id, user_id: uid }));
        const { error: e2 } = await sb.from('group_members').insert(rows);
        return { data: g, error: e2 };
    },
    myGroups: () => sb.from('groups')
        .select('*, group_members(user_id, profiles(username, avatar))')
        .order('created_at', { ascending: false }),
    groupById: (gid) => sb.from('groups')
        .select('*, group_members(user_id, profiles(username, avatar))').eq('id', gid).single(),
    addGroupMember: (gid, uid) => sb.from('group_members').insert({ group_id: gid, user_id: uid }),
    leaveGroup: (gid) => sb.from('group_members').delete().match({ group_id: gid, user_id: state.me.id }),
};

export { db };
