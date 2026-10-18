const ONBOARDING_SLIDES = [
    { icon: Compass, titleKey: "ob1_t", bodyKey: "ob1_b" },
    { icon: Lock, titleKey: "ob2_t", bodyKey: "ob2_b" },
    { icon: Users2, titleKey: "ob3_t", bodyKey: "ob3_b" },
    { icon: Image, titleKey: "ob4_t", bodyKey: "ob4_b" },
    { icon: Palette, titleKey: "ob5_t", bodyKey: "ob5_b" },
];
// ============================================================================
// غرف سوا — محادثة جماعية صوتية/مرئية بدعوة رابط
// ============================================================================
function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
const DEMO_PARTICIPANTS = [
    { id: "p-1", name: "أنت", mic: true, cam: true, host: true, avatar: "أ" },
    { id: "p-2", name: "نعمات بابكر", mic: true, cam: false, host: false, avatar: "ن" },
    { id: "p-3", name: "عثمان بابكر", mic: false, cam: true, host: false, avatar: "ع" },
];
// ============================================================
// LinkedDevicesScreen — الأجهزة المرتبطة (مثل واتساب Web)
// ============================================================
function LinkedDevicesScreen({ onBack }) {
    const { colors } = useTheme();
    const { showToast } = useToast();
    // online علم منطقي لا نصّ: كان اللون يُحسب بـ lastSeen.includes("متصل")
    // فتنكسر الحالة الخضراء بمجرّد ترجمة النصّ. والترجمة تتم وقت الرسم
    // لأن useState يُقيَّم مرّة واحدة عند التركيب فيتجمّد على لغة الدخول.
    const [devices, setDevices] = useState([
        { id: "d1", name: "Chrome على Windows", online: true, icon: "🖥️" },
        { id: "d2", name: "سوا Desktop — Mac", online: false, lastSeenKey: "dv_mndh_saatyn", icon: "💻" },
    ]);
    const [showQr, setShowQr] = useState(false);
    function removeDevice(id) {
        setDevices(prev => prev.filter(d => d.id !== id));
        showToast(t("tm_ilgha_rbt_aljhaz"), "success");
    }
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col", style: { backgroundColor: colors.bg } },
        React.createElement(TopBar, { title: t("alajhza_almrtbta"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto" },
            React.createElement("div", { className: "mx-4 mt-4 p-4 rounded-2xl", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("p", { className: `text-xs ${textStart()} leading-relaxed`, style: { color: colors.textMuted } }, t("arbt_swa_bmtsfhk_aw"))),
            React.createElement("div", { className: "px-4 mt-4" },
                React.createElement("button", { "aria-label": t("idafa"), onClick: () => setShowQr(!showQr), className: `w-full flex ${rowStart()} items-center justify-center gap-2 py-3 rounded-2xl font-bold text-sm`, style: { backgroundColor: colors.primary, color: "#fff" } },
                    React.createElement(Plus, { size: 16, color: "#fff" }),
                    t("rbt_jhaz_jdyd"))),
            showQr && (React.createElement("div", { className: "mx-4 mt-4 p-5 rounded-2xl flex flex-col items-center gap-3", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("p", { className: "text-xs font-bold", style: { color: colors.text } }, t("amsh_alrmz_mn_almtsfh")),
                React.createElement("div", { className: "w-36 h-36 rounded-xl flex items-center justify-center", style: { backgroundColor: "#fff", border: `1px solid ${colors.border}` } },
                    React.createElement(QrCode, { size: 100, color: "#000" })),
                React.createElement("p", { className: "text-[10px] text-center", style: { color: colors.textMuted } }, t("afth_sawa_app_web")))),
            devices.length > 0 && (React.createElement("div", { className: "px-4 mt-4" },
                React.createElement("p", { className: `text-xs font-extrabold mb-2 ${textStart()}`, style: { color: colors.textMuted } },
                    t("dv_alajhza_adad"),
                    devices.length,
                    ")"),
                devices.map(d => (React.createElement(Card, { key: d.id, className: "mb-2" },
                    React.createElement("div", { className: `flex ${rowStart()} items-center gap-3` },
                        React.createElement("span", { style: { fontSize: 28 } }, d.icon),
                        React.createElement("div", { className: `flex-1 ${textStart()}` },
                            React.createElement("p", { className: "text-sm font-bold", style: { color: colors.text } }, d.name),
                            React.createElement("p", { className: "text-[11px] mt-0.5", style: { color: d.online ? "#22C55E" : colors.textMuted } }, d.online ? t("dv_mtsl_alan") : t(d.lastSeenKey))),
                        React.createElement("button", { onClick: () => removeDevice(d.id), className: "px-3 py-1.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#ef444420", color: "#ef4444" } }, t("ilgha_alrbt")))))))),
            React.createElement("div", { className: "h-6" }))));
}
// ============================================================
// SawaWrapped — إحصائيات الاستخدام (مثل Spotify Wrapped)
// ============================================================
function SawaWrappedScreen({ onBack, conversations, groups, showToast = () => { } }) {
    var _a;
    const { colors } = useTheme();
    const totalConvs = ((conversations === null || conversations === void 0 ? void 0 : conversations.length) || 0) + ((groups === null || groups === void 0 ? void 0 : groups.length) || 0);
    const stats = [
        { label: t("sw_rsala_arslt"), value: "342", icon: "💬", color: colors.primary },
        { label: t("sw_dqyqa_mkalmat"), value: "87", icon: "📞", color: "#22C55E" },
        { label: t("sw_swra_wwthyqa"), value: "24", icon: "📎", color: colors.accent },
        { label: t("sw_mhadtha_nshta"), value: String(totalConvs), icon: "🗂️", color: "#8B5CF6" },
        { label: t("sw_rsala_swtya"), value: "15", icon: "🎙️", color: "#F59E0B" },
        { label: t("sw_lhza_nshrtha"), value: "6", icon: "✨", color: "#EC4899" },
    ];
    // إحصائيات العائلة
    const allFamilyP = Object.values((groups === null || groups === void 0 ? void 0 : groups.reduce) ? {} : {}).flat();
    const overdueFamily = typeof getOverduePersons !== "undefined" ? getOverduePersons({}) : [];
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col", style: { backgroundColor: colors.bg } },
        React.createElement(TopBar, { title: t("ihsayyaty"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4" },
            React.createElement("div", { className: "rounded-2xl p-5 mb-4 text-center", style: { background: `linear-gradient(135deg, ${colors.primary}, ${colors.accent})` } },
                React.createElement("p", { className: "text-white text-xs font-bold mb-1 opacity-80" }, t("swa_mlkhsk_hdha_alshhr")),
                React.createElement("p", { className: "text-white text-2xl font-extrabold" }, t("342_rsala")),
                React.createElement("p", { className: "text-white text-xs opacity-75 mt-1" }, t("ant_mn_akthr_almstkhdmyn"))),
            React.createElement("div", { className: "grid grid-cols-2 gap-3" }, stats.map((s, i) => (React.createElement("div", { key: i, className: `p-4 rounded-2xl ${textStart()}`, style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("span", { style: { fontSize: 24 } }, s.icon),
                React.createElement("p", { className: "text-2xl font-extrabold mt-1", style: { color: s.color } }, s.value),
                React.createElement("p", { className: "text-[11px] mt-0.5 leading-snug", style: { color: colors.textMuted } }, s.label))))),
            React.createElement("div", { className: `mt-4 p-4 rounded-2xl ${textStart()}`, style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("p", { className: "text-xs font-extrabold mb-2", style: { color: colors.text } }, t("akthr_mhadtha_hdha_alshhr")),
                React.createElement("p", { className: "text-sm font-bold", style: { color: colors.primary } }, ((_a = conversations === null || conversations === void 0 ? void 0 : conversations[1]) === null || _a === void 0 ? void 0 : _a.name) || "نعمات بابكر"),
                React.createElement("p", { className: "text-[11px] mt-0.5", style: { color: colors.textMuted } }, t("118_rsala_mtbadla"))),
            React.createElement("div", { className: `mt-3 p-4 rounded-2xl ${textStart()}`, style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("p", { className: "text-xs font-extrabold mb-3", style: { color: colors.text } }, t("sla_alrhm_hdha_alshhr")),
                React.createElement("div", { className: `flex ${rowStart()} gap-3` },
                    React.createElement("div", { className: "flex-1 p-2.5 rounded-xl text-center", style: { backgroundColor: "#22C55E15" } },
                        React.createElement("p", { className: "text-lg font-extrabold", style: { color: "#22C55E" } }, "12"),
                        React.createElement("p", { className: "text-[10px] mt-0.5", style: { color: colors.textMuted } }, t("twasl_fy_alwqt"))),
                    React.createElement("div", { className: "flex-1 p-2.5 rounded-xl text-center", style: { backgroundColor: "#ef444415" } },
                        React.createElement("p", { className: "text-lg font-extrabold", style: { color: "#ef4444" } }, "2"),
                        React.createElement("p", { className: "text-[10px] mt-0.5", style: { color: colors.textMuted } }, t("fathm_altwasl"))),
                    React.createElement("div", { className: "flex-1 p-2.5 rounded-xl text-center", style: { backgroundColor: colors.primary + "15" } },
                        React.createElement("p", { className: "text-lg font-extrabold", style: { color: colors.primary } }, "3"),
                        React.createElement("p", { className: "text-[10px] mt-0.5", style: { color: colors.textMuted } }, t("mnasbat_hnat"))))),
            React.createElement("button", { "aria-label": t("msharka"), onClick: () => showToast(t("tm_nskh_almlkhs_jahz"), "success"), className: `w-full mt-4 py-3 rounded-2xl font-bold text-sm flex ${rowStart()} items-center justify-center gap-2`, style: { backgroundColor: colors.primaryLight, color: colors.primary } },
                React.createElement(Share2, { size: 15, color: colors.primary }),
                t("shark_mlkhsk")),
            React.createElement("div", { className: "h-6" }))));
}
// ============================================================
// ScheduleRoomModal — جدولة غرفة سوا مسبقاً
// ============================================================
function ScheduleRoomModal({ onSave, onClose }) {
    const { colors } = useTheme();
    const { showToast } = useToast();
    const [title, setTitle] = useState("");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const code = useMemo(() => generateRoomCode(), []);
    const link = window.SawaRTC && window.SawaRTC.roomLink ? window.SawaRTC.roomLink(code) : "sawa.app/room/" + code;
    function save() {
        if (!title.trim() || !date || !time) {
            showToast(t("akml_alanwan_waltarykh_walwqt"), "error");
            return;
        }
        onSave({ id: "sr-" + Date.now(), code, link, title: title.trim(), at: new Date(date + "T" + time).getTime() });
        showToast(t("jdwlt_alghrfa_alrabt_jahz"), "success");
        onClose();
    }
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.45)" } }),
        React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 41, backgroundColor: colors.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 16 } },
            React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto my-3", style: { backgroundColor: colors.border } }),
            React.createElement("p", { className: "text-sm font-extrabold text-center mb-4", style: { color: colors.text } }, t("jdwla_ghrfa_swa")),
            React.createElement("div", { className: "px-5" },
                React.createElement("label", { className: `text-[11px] font-bold block ${textStart()} mb-1`, style: { color: colors.textMuted } }, t("anwan_alajtmaa")),
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: title, onChange: (e) => setTitle(e.target.value), placeholder: t("mthal_ajtmaa_alaayla_alasbway"), className: "w-full rounded-xl px-3 py-2.5 text-sm mb-3", style: { backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, minWidth: 0 } }),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-3` },
                    React.createElement("div", { className: "flex-1", style: { minWidth: 0 } },
                        React.createElement("label", { className: `text-[11px] font-bold block ${textStart()} mb-1`, style: { color: colors.textMuted } }, t("altarykh")),
                        React.createElement("input", { dir: "ltr", type: "date", value: date, onChange: (e) => setDate(e.target.value), className: "w-full rounded-xl px-3 py-2.5 text-sm", style: { backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, minWidth: 0 } })),
                    React.createElement("div", { className: "flex-1", style: { minWidth: 0 } },
                        React.createElement("label", { className: `text-[11px] font-bold block ${textStart()} mb-1`, style: { color: colors.textMuted } }, t("alwqt")),
                        React.createElement("input", { dir: "ltr", type: "time", value: time, onChange: (e) => setTime(e.target.value), className: "w-full rounded-xl px-3 py-2.5 text-sm", style: { backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, minWidth: 0 } }))),
                React.createElement("div", { className: `rounded-xl px-3 py-2.5 mb-4 flex ${rowStart()} items-center gap-2`, style: { backgroundColor: colors.primaryLight, border: `1px solid ${colors.primary}33` } },
                    React.createElement(Link2, { size: 14, color: colors.primary }),
                    React.createElement("span", { className: `flex-1 ${textStart()} text-xs font-bold truncate`, style: { color: colors.primary }, dir: "ltr" }, link),
                    React.createElement("button", { onClick: () => { copyText(link); showToast(t("nskh_alrabt_2"), "success"); }, className: "text-[10px] font-extrabold px-2 py-1 rounded-lg", "aria-label": t("nskh"), style: { backgroundColor: colors.primary, color: "#fff" } }, t("nskh"))),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("button", { onClick: save, className: "flex-1 py-3 rounded-xl text-sm font-extrabold", style: { backgroundColor: colors.primary, color: "#fff" } }, t("hfz_almwad")),
                    React.createElement("button", { onClick: onClose, className: "flex-1 py-3 rounded-xl text-sm font-bold", style: { backgroundColor: colors.bg, color: colors.textMuted, border: `1px solid ${colors.border}` } }, t("ilgha")))))));
}
function SawaRoomScreen({ roomCode, onBack, familyMembers = [], onInviteFamily, groups = [], onSendTasksToGroup }) {
    var _a, _b, _c;
    const { colors, dataSaver } = useTheme();
    const { showToast } = useToast();
    const [participants, setParticipants] = useState([DEMO_PARTICIPANTS[0]]);
    const [myMic, setMyMic] = useState(true);
    const [myCam, setMyCam] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const [chatMessages, setChatMessages] = useState([]);
    const [chatText, setChatText] = useState("");
    const [elapsed, setElapsed] = useState(0);
    const [handRaised, setHandRaised] = useState(false);
    const [joining, setJoining] = useState(true);
    const [showQr, setShowQr] = useState(false);
    const [confirmLeave, setConfirmLeave] = useState(false);
    const [unreadChat, setUnreadChat] = useState(0);
    const [raisedHands, setRaisedHands] = useState([]); // معرّفات من رفعوا أيديهم
    const [roomLocked, setRoomLocked] = useState(false);
    const [hostMenu, setHostMenu] = useState(null); // المشارك المختار | null
    const [hostConfirm, setHostConfirm] = useState(null); // {action, participant} | null
    const [chatMode, setChatMode] = useState("casual"); // casual | business
    const [floatingReactions, setFloatingReactions] = useState([]);
    const [showReactionBar, setShowReactionBar] = useState(false);
    const [lowDataMode, setLowDataMode] = useState(dataSaver);
    const [activeSpeaker, setActiveSpeaker] = useState(null);
    const [noteKind, setNoteKind] = useState("point"); // decision | task | point
    const [showSummary, setShowSummary] = useState(false);
    const [sendingTasks, setSendingTasks] = useState(false);
    const [durationLimit, setDurationLimit] = useState(0); // بالدقائق، 0 = بلا حد
    const [showDurationPick, setShowDurationPick] = useState(false);
    const [expiryWarned, setExpiryWarned] = useState(false);
    const [showFamilyInvite, setShowFamilyInvite] = useState(false);
    const [pickedFamily, setPickedFamily] = useState([]);
    // ⚠️ غرفة الانتظار والرابط المخصص واجهة فقط — التحقق الفعلي يلزم الخادم عند كل طلب انضمام
    const [waitingRoomOn, setWaitingRoomOn] = useState(false);
    const [waitingQueue, setWaitingQueue] = useState([]);
    const [customSlug, setCustomSlug] = useState("");
    const [editingSlug, setEditingSlug] = useState(false);
    const [slugDraft, setSlugDraft] = useState("");
    const [isTyping, setIsTyping] = useState(false); // حالة الكتابة — تُصغّر شبكة المشاركين
    const amHost = (_a = participants.find((p) => p.id === "p-1")) === null || _a === void 0 ? void 0 : _a.host;
    const liveHostTarget = hostMenu ? participants.find((p) => p.id === hostMenu.id) : null;
    // المضيف يكتم مباشرة، لكن لا يفتح ميكروفون أحد بالقوة — يطلب فقط
    function muteParticipant(id) {
        const p = participants.find((x) => x.id === id);
        setParticipants((ps) => ps.map((x) => x.id === id ? { ...x, mic: false } : x));
        showToast(t("ktm_2", { name: p === null || p === void 0 ? void 0 : p.name }), "success");
    }
    function requestUnmute(id) {
        const p = participants.find((x) => x.id === id);
        setChatMessages((m) => [...m, {
                id: Date.now(), sender: t("rm_alnzam"), system: true,
                text: t("rm_tlb_almdyf_mn") + (p === null || p === void 0 ? void 0 : p.name) + t("rm_fth_almyk_sfx"),
                time: new Date().toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }),
            }]);
        if (!chatOpen)
            setUnreadChat((u) => u + 1);
        showToast(t("arsl_altlb_ila", { name: p === null || p === void 0 ? void 0 : p.name }), "success");
    }
    function muteEveryone() {
        setParticipants((ps) => ps.map((x) => x.id === "p-1" ? x : { ...x, mic: false }));
        showToast(t("ktm_jmya_almsharkyn"), "success");
    }
    function removeParticipant(id) {
        const p = participants.find((x) => x.id === id);
        setParticipants((ps) => ps.filter((x) => x.id !== id));
        setRaisedHands((r) => r.filter((x) => x !== id));
        if (id === "p-1")
            setHandRaised(false);
        showToast(t("azyl", { name: p === null || p === void 0 ? void 0 : p.name }), "success");
    }
    function transferHost(id) {
        var _a;
        setParticipants((ps) => ps.map((p) => ({ ...p, host: p.id === id })));
        showToast(t("nqlt_alastdafa_ila", { name: (_a = participants.find((x) => x.id === id)) === null || _a === void 0 ? void 0 : _a.name }), "info");
    }
    const roomLink = `sawa.app/room/${customSlug || roomCode}`;
    function saveSlug() {
        const clean = slugDraft.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "");
        if (clean.length < 3) {
            showToast(t("alasm_qsyr_jda"), "error");
            return;
        }
        setCustomSlug(clean);
        setEditingSlug(false);
        showToast(t("sar_rabtk_sawa_app", { slug: clean }), "success");
    }
    function admitGuest(g) {
        setWaitingQueue((q) => q.filter((x) => x.id !== g.id));
        setParticipants((p) => [...p, { id: g.id, name: g.name, mic: true, cam: false, host: false, avatar: g.name.charAt(0) }]);
        showToast(t("dkhl_2", { name: g.name }), "success");
    }
    function denyGuest(g) {
        setWaitingQueue((q) => q.filter((x) => x.id !== g.id));
        showToast(t("rfd_dkhwl", { name: g.name }), "info");
    }
    // محاكاة انضمام مشاركين تدريجياً
    useEffect(() => {
        const t1 = setTimeout(() => {
            setParticipants((p) => [...p, DEMO_PARTICIPANTS[1]]);
            setJoining(false);
        }, 2000);
        const t2 = setTimeout(() => {
            const g = DEMO_PARTICIPANTS[2];
            if (waitingRoomOn) {
                setWaitingQueue((q) => q.some((x) => x.id === g.id) ? q : [...q, { id: g.id, name: g.name }]);
            }
            else {
                setParticipants((p) => p.some((x) => x.id === g.id) ? p : [...p, g]);
            }
        }, 5000);
        return () => { clearTimeout(t1); clearTimeout(t2); };
    }, []);
    // مؤقت الغرفة
    useEffect(() => {
        const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(timer);
    }, []);
    const remainingSec = durationLimit ? durationLimit * 60 - elapsed : null;
    useEffect(() => {
        if (remainingSec === null)
            return;
        if (remainingSec === 300 && !expiryWarned) {
            setExpiryWarned(true);
            showToast(t("tbqt_dqayq_ala"), "info");
        }
        if (remainingSec <= 0) {
            showToast(t("antha_wqt_alghrfa"), "info");
            onBack();
        }
    }, [remainingSec, expiryWarned, showToast, onBack]);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    function copyLink() {
        copyText(roomLink);
        showToast(t("tm_nskh_rabt_alghrfa"), "success");
    }
    function toggleHand() {
        const next = !handRaised;
        setHandRaised(next);
        setRaisedHands((r) => next ? [...r, "p-1"] : r.filter((x) => x !== "p-1"));
        showToast(next ? t("rm_rft_ydk") : t("rm_anzlt_ydk"), next ? "success" : "info");
    }
    const ROOM_REACTIONS = ["👏", "❤️", "😂", "👍", "🤲", "🎉"];
    function sendReaction(emoji) {
        const id = Date.now() + Math.random();
        setFloatingReactions((r) => [...r, { id, emoji, left: 12 + Math.random() * 70 }]);
        setTimeout(() => setFloatingReactions((r) => r.filter((x) => x.id !== id)), 2600);
    }
    // محاكاة المتحدث الحالي: يتغيّر بين من ميكروفونهم مفتوح
    useEffect(() => {
        const tmr = setInterval(() => {
            const speaking = participants.filter((p) => p.mic);
            setActiveSpeaker(speaking.length ? speaking[Math.floor(Math.random() * speaking.length)].id : null);
        }, 3200);
        return () => clearInterval(tmr);
    }, [participants]);
    const NOTE_KINDS = {
        decision: { label: t("rm_qrar"), icon: "✅", color: "#22C55E" },
        task: { label: t("rm_mhma"), icon: "📌", color: "#F59E0B" },
        point: { label: t("rm_nqta"), icon: "💬", color: "#60A5FA" },
    };
    function sendChat() {
        if (!chatText.trim())
            return;
        setChatMessages((m) => [...m, {
                id: Date.now(),
                sender: t("rm_ant"),
                text: chatText.trim(),
                kind: chatMode === "business" ? noteKind : null,
                atSecond: elapsed,
                time: new Date().toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }),
            }]);
        setChatText("");
    }
    const businessNotes = chatMessages.filter((m) => m.kind && !m.system);
    const taskNotes = businessNotes.filter((m) => m.kind === "task");
    function exportSummary() {
        const stamp = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
        let out = t("rm_mhdr_anwan");
        out += t("rm_altarykh") + new Date().toLocaleString(loc()) + "\n";
        out += t("rm_almda") + mins + ":" + secs + "\n";
        out += t("rm_alhdwr") + participants.map((p) => p.name).join(t("fasl_qayma")) + "\n";
        out += "=".repeat(40) + "\n\n";
        ["decision", "task", "point"].forEach((k) => {
            const items = businessNotes.filter((m) => m.kind === k);
            if (!items.length)
                return;
            out += NOTE_KINDS[k].label + " (" + items.length + "):\n";
            items.forEach((m, i) => { out += "  " + (i + 1) + ". [" + stamp(m.atSecond) + "] " + m.text + " — " + m.sender + "\n"; });
            out += "\n";
        });
        if (!businessNotes.length)
            out += t("rm_lm_tsjl");
        saveTextFile(t("rm_mlf_mhdr") + roomCode + ".txt", out);
        showToast(t("nzl_almhdr", { count: businessNotes.length }), "success");
    }
    // شاشة الانتظار
    if (joining) {
        return (React.createElement("div", { className: "flex-1 flex flex-col items-center justify-center", style: { backgroundColor: "#0f172a" } },
            React.createElement("div", { className: "w-20 h-20 rounded-full flex items-center justify-center mb-6 animate-pulse", style: { backgroundColor: colors.primary + "33", border: `2px solid ${colors.primary}` } },
                React.createElement(Video, { size: 36, color: colors.primary })),
            React.createElement("p", { className: "text-white font-extrabold text-lg mb-2" }, t("jary_alandmam_llghrfa")),
            React.createElement("p", { className: "text-sm font-bold mb-8", style: { color: "#94a3b8" } }, roomLink),
            React.createElement("button", { onClick: onBack, className: "text-xs font-bold", style: { color: "#94a3b8" } }, t("ilgha"))));
    }
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col", style: { backgroundColor: "#0f172a" } },
        React.createElement("div", { style: { display: "flex", flexDirection: "row", direction: "ltr", alignItems: "center", padding: "0.75rem 1rem", backgroundColor: "#1e293b" } },
            React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => setConfirmLeave(true), className: "w-8 h-8 flex items-center justify-center rounded-full", style: { backgroundColor: "#334155" } },
                React.createElement(X, { size: 16, color: "#fff" })),
            React.createElement("div", { className: "flex-1 min-w-0 text-center" },
                React.createElement("p", { className: "text-white font-extrabold text-sm truncate" }, t("ghrfa_swa")),
                React.createElement("p", { className: "text-xs font-bold truncate", style: { color: remainingSec !== null && remainingSec <= 300 ? "#ef4444" : "#94a3b8" } },
                    remainingSec !== null
                        ? t("rm_bqy_") + String(Math.floor(remainingSec / 60)).padStart(2, "0") + ":" + String(remainingSec % 60).padStart(2, "0")
                        : mins + ":" + secs,
                    " · ",
                    participants.length,
                    "",
                    roomLocked ? " · 🔒" : "")),
            React.createElement("div", { className: "flex flex-row items-center gap-1.5 shrink-0" },
                React.createElement("button", { onClick: () => { setLowDataMode(!lowDataMode); showToast(lowDataMode ? t("rm_aad_alfydw") : t("rm_wda_swty_byanat"), "success"); }, className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: lowDataMode ? "#f59e0b33" : "#334155", border: lowDataMode ? "1px solid #f59e0b55" : "none" }, "aria-label": lowDataMode ? t("rm_tshghyl_alfydw") : t("rm_wda_swty"), title: lowDataMode ? t("rm_tshghyl_alfydw") : t("rm_wda_swty_byanat") }, lowDataMode ? React.createElement(VideoOff, { size: 14, color: "#f59e0b" }) : React.createElement(Video, { size: 14, color: "#94a3b8" })),
                amHost && (React.createElement("button", { onClick: () => setShowDurationPick(true), className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: durationLimit ? "#f59e0b33" : "#334155", border: durationLimit ? "1px solid #f59e0b55" : "none" }, "aria-label": t("mda_alghrfa"), title: t("thdyd_mda_alghrfa") },
                    React.createElement(Clock, { size: 14, color: durationLimit ? "#f59e0b" : "#94a3b8" }))),
                amHost && (React.createElement("button", { onClick: () => { setWaitingRoomOn(!waitingRoomOn); showToast(waitingRoomOn ? t("rm_alghyt_ghrfa") : t("rm_ghrfa_mfala"), "success"); }, className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: waitingRoomOn ? colors.primary + "33" : "#334155", border: waitingRoomOn ? `1px solid ${colors.primary}55` : "none" }, "aria-label": t("ghrfa_alantzar"), title: waitingRoomOn ? t("rm_ilgha_ghrfa") : t("rm_tfayl_ghrfa") },
                    React.createElement(Users2, { size: 14, color: waitingRoomOn ? colors.primary : "#94a3b8" }))),
                amHost && (React.createElement("button", { "aria-label": t("qfl"), onClick: () => { setRoomLocked(!roomLocked); showToast(roomLocked ? t("rm_ftht_alghrfa") : t("rm_qflt_alghrfa"), "success"); }, className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: roomLocked ? "#ef444433" : "#334155", border: roomLocked ? "1px solid #ef444455" : "none" }, title: roomLocked ? t("rm_fth_alghrfa") : t("rm_qfl_alghrfa") },
                    React.createElement(Lock, { size: 14, color: roomLocked ? "#ef4444" : "#94a3b8" }))),
                React.createElement("button", { "aria-label": t("rm_nskh"), onClick: copyLink, className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: "#334155" } },
                    React.createElement(Copy, { size: 14, color: "#94a3b8" })))),
        React.createElement("div", { className: `mx-4 mt-3 rounded-2xl px-4 py-3 flex ${rowStart()} items-center gap-3`, style: { backgroundColor: "#1e293b", border: "1px solid #334155" } },
            React.createElement("div", { className: `flex-1 ${textStart()}`, style: { minWidth: 0 } },
                React.createElement("p", { className: "text-xs font-bold mb-0.5", style: { color: "#94a3b8" } }, t("rabt_aldawa")),
                editingSlug ? (React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5` },
                    React.createElement("input", { dir: "ltr", value: slugDraft, autoFocus: true, onChange: (e) => setSlugDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && saveSlug(), placeholder: t("asm_alghrfa"), className: "flex-1 rounded-lg px-2 py-1 text-xs font-bold", style: { backgroundColor: "#0f172a", color: "#e2e8f0", border: "1px solid #475569", minWidth: 0 } }),
                    React.createElement("button", { onClick: saveSlug, className: "text-[10px] font-extrabold px-2 py-1 rounded-lg", style: { backgroundColor: colors.primary, color: "#fff" } }, t("hfz")))) : (React.createElement("button", { onClick: () => { setSlugDraft(customSlug || ""); setEditingSlug(true); }, className: `w-full ${textStart()}`, "aria-label": t("tadyl_alrabt") },
                    React.createElement("p", { className: "text-sm font-extrabold truncate", style: { color: "#e2e8f0" }, dir: "ltr" }, roomLink),
                    React.createElement("p", { className: "text-[9px] mt-0.5", style: { color: colors.primary } }, t("adght_ltkhsys_alasm"))))),
            React.createElement("button", { "aria-label": t("nskh"), onClick: copyLink, className: "w-9 h-9 rounded-xl flex items-center justify-center shrink-0", style: { backgroundColor: "#334155" } },
                React.createElement(Copy, { size: 15, color: "#94a3b8" })),
            React.createElement("button", { "aria-label": t("rmz_qr"), onClick: () => setShowQr(true), className: "w-9 h-9 rounded-xl flex items-center justify-center shrink-0", style: { backgroundColor: showQr ? colors.primary : "#334155" } },
                React.createElement(QrCode, { size: 15, color: showQr ? "#fff" : "#94a3b8" }))),
        amHost && waitingQueue.length > 0 && (React.createElement("div", { className: "mx-4 mt-2 rounded-xl px-3 py-2", style: { backgroundColor: colors.primary + "1a", border: `1px solid ${colors.primary}55` } },
            React.createElement("p", { className: `text-[11px] font-extrabold ${textStart()} mb-1.5`, style: { color: colors.primary } },
                "\uD83D\uDEAA ",
                waitingQueue.length,
                t("rm_fy_ghrfa_alantzar")),
            waitingQueue.map((g) => (React.createElement("div", { key: g.id, className: `flex ${rowStart()} items-center gap-2 mb-1` },
                React.createElement("span", { className: `flex-1 ${textStart()} text-xs font-bold text-white truncate` }, g.name),
                React.createElement("button", { onClick: () => admitGuest(g), className: "px-2.5 py-1 rounded-lg text-[10px] font-extrabold", style: { backgroundColor: "#22C55E", color: "#fff" } }, t("smah")),
                React.createElement("button", { onClick: () => denyGuest(g), className: "px-2.5 py-1 rounded-lg text-[10px] font-bold", style: { backgroundColor: "#334155", color: "#94a3b8" } }, t("rfd"))))))),
        raisedHands.length > 0 && (React.createElement("div", { className: `mx-4 mt-2 rounded-xl px-3 py-2 flex ${rowStart()} items-center gap-2`, style: { backgroundColor: "#f59e0b22", border: "1px solid #f59e0b55" } },
            React.createElement("span", { style: { fontSize: 14 } }, "\u270B"),
            React.createElement("span", { className: `flex-1 ${textStart()} text-[11px] font-bold`, style: { color: "#f59e0b" } },
                raisedHands.length,
                t("rm_fy_antzar_aladhn")),
            React.createElement("button", { onClick: () => { setRaisedHands([]); setHandRaised(false); }, className: "text-[10px] font-bold px-2 py-1 rounded-lg", style: { backgroundColor: "#f59e0b33", color: "#f59e0b" } }, t("msh_alkl")))),
        isTyping ? (React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 px-3 shrink-0`, style: { backgroundColor: "#0f172a", borderBottom: "1px solid #1e293b", height: 40, transition: "height .25s" } },
            React.createElement("span", { className: "text-[9px] font-bold shrink-0", style: { color: "#475569" } }, t("rm_msharkwn")),
            participants.map((p) => (React.createElement("div", { key: p.id, className: "w-7 h-7 rounded-full flex items-center justify-center font-extrabold text-xs shrink-0", style: {
                    backgroundColor: p.id === "p-1" ? colors.primary : "#334155",
                    color: "#fff",
                    border: activeSpeaker === p.id && p.mic ? "2px solid #22C55E"
                        : p.id === "p-1" ? `2px solid ${colors.primary}88` : "2px solid #475569",
                    boxShadow: activeSpeaker === p.id && p.mic ? "0 0 0 2px #22C55E33" : "none",
                    transition: "border-color .2s, box-shadow .2s",
                }, title: p.name }, p.avatar))),
            activeSpeaker && ((_b = participants.find((p) => p.id === activeSpeaker)) === null || _b === void 0 ? void 0 : _b.mic) && (React.createElement("span", { className: "text-[9px] font-bold", style: { color: "#22C55E" } },
                "\u25CF ", (_c = participants.find((p) => p.id === activeSpeaker)) === null || _c === void 0 ? void 0 :
                _c.name)))) : chatOpen ? (React.createElement("div", { className: "grid grid-cols-2 gap-2 px-3 shrink-0", style: { height: 100, padding: "6px 12px" } },
            participants.map((p) => (React.createElement("div", { key: p.id, onClick: () => { if (amHost && p.id !== "p-1")
                    setHostMenu(p); }, className: "rounded-xl flex flex-col items-center justify-center relative overflow-hidden", style: {
                    backgroundColor: "#1e293b",
                    border: activeSpeaker === p.id && p.mic ? "2px solid #22C55E"
                        : p.id === "p-1" ? `2px solid ${colors.primary}` : "2px solid #334155",
                    boxShadow: activeSpeaker === p.id && p.mic ? "0 0 0 2px #22C55E33" : "none",
                    transition: "border-color .25s, box-shadow .25s",
                    cursor: amHost && p.id !== "p-1" ? "pointer" : "default",
                } },
                React.createElement("div", { className: "w-8 h-8 rounded-full flex items-center justify-center font-extrabold text-sm mb-1", style: { backgroundColor: p.id === "p-1" ? colors.primary : "#334155", color: "#fff" } }, p.cam && !lowDataMode ? React.createElement(Video, { size: 14, color: "#fff" }) : p.avatar),
                React.createElement("p", { className: "text-[9px] font-bold text-white truncate px-1", style: { maxWidth: "100%" } }, p.name),
                React.createElement("div", { className: "absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center", style: { backgroundColor: p.mic ? "#22c55e33" : "#ef444433" } }, p.mic ? React.createElement(Mic, { size: 8, color: "#22c55e" }) : React.createElement(MicOff, { size: 8, color: "#ef4444" })),
                raisedHands.includes(p.id) && React.createElement("div", { className: "absolute bottom-1 left-1 text-xs" }, "\u270B")))),
            participants.length < 4 && (React.createElement("button", { onClick: () => familyMembers.length ? setShowFamilyInvite(true) : copyLink(), className: "rounded-xl flex flex-col items-center justify-center gap-1", style: { backgroundColor: "#1e293b", border: "2px dashed #334155" }, "aria-label": t("dawa_mshark") },
                React.createElement(UserPlus, { size: 14, color: "#475569" }),
                React.createElement("span", { className: "text-[8px] font-bold", style: { color: "#475569" } }, t("dawa_mshark")))))) : (React.createElement("div", { className: "flex-1 p-4 grid grid-cols-2 gap-3 overflow-y-auto", style: { gridAutoRows: "minmax(120px, auto)" } },
            participants.map((p) => (React.createElement("div", { key: p.id, onClick: () => { if (amHost && p.id !== "p-1")
                    setHostMenu(p); }, className: "rounded-2xl flex flex-col items-center justify-center relative overflow-hidden", style: {
                    backgroundColor: "#1e293b",
                    border: activeSpeaker === p.id && p.mic ? "2px solid #22C55E"
                        : p.id === "p-1" ? `2px solid ${colors.primary}` : "2px solid #334155",
                    boxShadow: activeSpeaker === p.id && p.mic ? "0 0 0 3px #22C55E33" : "none",
                    transition: "border-color .25s, box-shadow .25s",
                    minHeight: 120,
                    cursor: amHost && p.id !== "p-1" ? "pointer" : "default",
                } },
                React.createElement("div", { className: "w-14 h-14 rounded-full flex items-center justify-center font-extrabold text-xl mb-2", style: { backgroundColor: p.id === "p-1" ? colors.primary : "#334155", color: "#fff" } }, p.cam && !lowDataMode ? React.createElement(Video, { size: 24, color: "#fff" }) : p.avatar),
                React.createElement("p", { className: "text-xs font-bold text-white truncate px-2", style: { maxWidth: "100%" } }, p.name),
                React.createElement("div", { className: "absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center", style: { backgroundColor: p.mic ? "#22c55e33" : "#ef444433" } }, p.mic ? React.createElement(Mic, { size: 11, color: "#22c55e" }) : React.createElement(MicOff, { size: 11, color: "#ef4444" })),
                p.host && (React.createElement("div", { className: "absolute top-2 left-2 px-1.5 py-0.5 rounded-full", style: { backgroundColor: colors.primary + "55" } },
                    React.createElement("span", { className: "text-[9px] font-extrabold", style: { color: colors.primary } }, t("mdyf")))),
                raisedHands.includes(p.id) && React.createElement("div", { className: "absolute bottom-2 left-2 text-base" }, "\u270B")))),
            participants.length < 4 && (React.createElement("button", { onClick: () => familyMembers.length ? setShowFamilyInvite(true) : copyLink(), className: "rounded-2xl flex flex-col items-center justify-center gap-2", style: { backgroundColor: "#1e293b", border: "2px dashed #334155", minHeight: 120 }, "aria-label": t("dawa_mshark") },
                React.createElement(UserPlus, { size: 22, color: "#475569" }),
                React.createElement("span", { className: "text-xs font-bold", style: { color: "#475569" } }, t("dawa_mshark")),
                familyMembers.length > 0 && (React.createElement("span", { className: "text-[9px] font-bold", style: { color: colors.accent } }, t("aw_ada_alaayla"))))))),
        chatOpen && (React.createElement("div", { className: "mx-4 mb-2 rounded-2xl overflow-hidden flex flex-col", style: { backgroundColor: "#1e293b", border: "1px solid #334155", flex: isTyping ? 1 : "0 0 auto", maxHeight: isTyping ? "none" : 220, transition: "flex .25s, max-height .25s" } },
            React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 px-3 py-2 border-b shrink-0`, style: { borderColor: "#334155" } },
                React.createElement("div", { className: `flex ${rowStart()} rounded-lg overflow-hidden shrink-0`, style: { border: "1px solid #334155" } }, [{ k: "casual", l: t("rm_drdsha") }, { k: "business", l: t("rm_amal") }].map((chatMode_item) => (React.createElement("button", { key: chatMode_item.k, onClick: () => setChatMode(chatMode_item.k), className: "px-2.5 py-1 text-[10px] font-extrabold", style: { backgroundColor: chatMode === chatMode_item.k ? colors.primary : "transparent", color: chatMode === chatMode_item.k ? "#fff" : "#94a3b8" } }, chatMode_item.l)))),
                React.createElement("div", { className: "flex-1" }),
                chatMode === "business" && (React.createElement("button", { onClick: () => setShowSummary(true), className: "px-2 py-1 rounded-lg text-[10px] font-bold shrink-0", style: { backgroundColor: "#22C55E22", color: "#22C55E" } },
                    t("rm_mhdr_adad"),
                    businessNotes.length,
                    ")")),
                React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => { setChatOpen(false); setIsTyping(false); }, className: "shrink-0" },
                    React.createElement(X, { size: 14, color: "#94a3b8" }))),
            React.createElement("div", { className: "overflow-y-auto px-3 py-2", style: { maxHeight: 110 } },
                (chatMode === "business" ? chatMessages.filter((m) => m.kind || m.system) : chatMessages).length === 0 && (React.createElement("p", { className: "text-xs text-center", style: { color: "#475569" } }, chatMode === "business" ? t("rm_sjl_qrarat") : t("rm_la_rsayl"))),
                (chatMode === "business" ? chatMessages.filter((m) => m.kind || m.system) : chatMessages).map((m) => (m.system ? (React.createElement("p", { key: m.id, className: "text-[10px] text-center my-1.5 italic", style: { color: "#64748b" } }, m.text)) : (React.createElement("div", { key: m.id, className: `mb-2 ${textStart()}` },
                    m.kind && (React.createElement("span", { className: `text-[9px] font-extrabold px-1.5 py-0.5 rounded ${ms("1")}`, style: { backgroundColor: NOTE_KINDS[m.kind].color + "22", color: NOTE_KINDS[m.kind].color } },
                        NOTE_KINDS[m.kind].icon,
                        " ",
                        NOTE_KINDS[m.kind].label)),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.primary } },
                        m.sender,
                        " "),
                    React.createElement("span", { className: "text-[10px]", style: { color: "#94a3b8" } }, m.time),
                    React.createElement("p", { className: "text-xs text-white mt-0.5" }, m.text)))))),
            chatMode === "business" && (React.createElement("div", { className: `flex ${rowStart()} gap-1.5 px-3 pb-1.5` }, Object.entries(NOTE_KINDS).map(([k, v]) => (React.createElement("button", { key: k, onClick: () => setNoteKind(k), className: "px-2 py-1 rounded-lg text-[10px] font-bold", style: {
                    backgroundColor: noteKind === k ? v.color + "33" : "#0f172a",
                    color: noteKind === k ? v.color : "#64748b",
                    border: "1px solid " + (noteKind === k ? v.color + "66" : "#334155"),
                } },
                v.icon,
                " ",
                v.label))))),
            React.createElement("div", { className: `flex ${rowStart()} gap-2 px-3 pb-2` },
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: chatText, onChange: (e) => setChatText(e.target.value), onFocus: () => setIsTyping(true), onBlur: () => setIsTyping(false), onKeyDown: (e) => e.key === "Enter" && sendChat(), placeholder: chatMode === "business" ? t("rm_sjl_") + NOTE_KINDS[noteKind].label + "..." : t("rm_aktb_rsala"), className: "flex-1 rounded-xl px-3 py-1.5 text-xs", style: { backgroundColor: "#0f172a", color: "#e2e8f0", border: `1px solid ${isTyping ? colors.primary + "88" : "#334155"}`, minWidth: 0 } }),
                React.createElement("button", { "aria-label": t("irsal"), onClick: () => { sendChat(); setIsTyping(false); }, className: "w-8 h-8 rounded-xl flex items-center justify-center", style: { backgroundColor: colors.primary } },
                    React.createElement(Send, { size: 13, color: "#fff", style: { transform: "scaleX(-1)" } }))))),
        showQr && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowQr(false), style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 24, right: 24, top: "22%", zIndex: 41, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", padding: 20 } },
                React.createElement("p", { className: "text-white font-extrabold text-sm text-center mb-1" }, t("amsh_llandmam")),
                React.createElement("p", { className: "text-[11px] text-center mb-4", style: { color: "#94a3b8" } }, t("wjh_kamyra_alhatf_nhw")),
                React.createElement("div", { className: "w-44 h-44 rounded-2xl flex items-center justify-center mx-auto mb-4", style: { backgroundColor: "#fff" } },
                    React.createElement(QrCode, { size: 130, color: "#000" })),
                React.createElement("p", { className: "text-[11px] text-center font-bold mb-4", style: { color: "#e2e8f0" }, dir: "ltr" }, roomLink),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("button", { onClick: copyLink, className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: colors.primary, color: "#fff" } }, t("nskh_alrabt")),
                    React.createElement("button", { onClick: () => setShowQr(false), className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#94a3b8" } }, t("ighlaq")))))),
        confirmLeave && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setConfirmLeave(false), style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 24, right: 24, top: "34%", zIndex: 41, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", padding: 20 } },
                React.createElement("p", { className: "text-white font-extrabold text-sm text-center mb-1" }, t("mghadra_alghrfa")),
                React.createElement("p", { className: "text-[11px] text-center mb-5", style: { color: "#94a3b8" } }, t("alghrfa_ststmr_ma_bqya")),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("button", { onClick: onBack, className: "flex-1 py-2.5 rounded-xl text-xs font-extrabold", style: { backgroundColor: "#ef4444", color: "#fff" } }, t("mghadra_2")),
                    React.createElement("button", { onClick: () => setConfirmLeave(false), className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("albqa")))))),
        hostMenu && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setHostMenu(null), style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 41, backgroundColor: "#1e293b", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 12 } },
                React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto my-3", style: { backgroundColor: "#334155" } }),
                React.createElement("p", { className: "text-white font-extrabold text-sm text-center mb-2" }, hostMenu.name),
                [
                    ((liveHostTarget === null || liveHostTarget === void 0 ? void 0 : liveHostTarget.mic)
                        ? { icon: MicOff, label: t("rm_ktm_almshark"), act: () => muteParticipant(hostMenu.id) }
                        : { icon: Mic, label: t("rm_tlb_fth_almyk"), act: () => requestUnmute(hostMenu.id) }),
                    { icon: MicOff, label: t("rm_ktm_aljmya"), act: muteEveryone },
                    { icon: Crown, label: t("rm_nql_alastdafa"), act: () => setHostConfirm({ action: "host", p: hostMenu }) },
                    { icon: X, label: t("rm_izala_mn"), act: () => setHostConfirm({ action: "remove", p: hostMenu }), danger: true },
                ].map((it) => (React.createElement("button", { key: it.label, onClick: () => { it.act(); setHostMenu(null); }, className: `w-full flex ${rowStart()} items-center gap-3 px-5 py-3.5`, style: { borderTop: "1px solid #334155" } },
                    React.createElement(it.icon, { size: 17, color: it.danger ? "#ef4444" : "#94a3b8" }),
                    React.createElement("span", { className: `flex-1 ${textStart()} text-sm font-bold`, style: { color: it.danger ? "#ef4444" : "#e2e8f0" } }, it.label))))))),
        showFamilyInvite && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowFamilyInvite(false), style: { position: "fixed", inset: 0, zIndex: 42, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 16, right: 16, top: "14%", bottom: "14%", zIndex: 43, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", display: "flex", flexDirection: "column" } },
                React.createElement("div", { className: "px-4 pt-4 pb-2 shrink-0" },
                    React.createElement("p", { className: "text-white font-extrabold text-sm text-center" }, t("dawa_alaayla")),
                    React.createElement("p", { className: "text-[11px] text-center mt-1", style: { color: "#94a3b8" } }, t("yrsl_alrabt_lkl_mn"))),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 px-4 pb-2 shrink-0` },
                    React.createElement("button", { onClick: () => setPickedFamily(familyMembers.map((m) => m.id)), className: "text-[10px] font-bold px-2 py-1 rounded-lg", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("thdyd_alkl")),
                    React.createElement("button", { onClick: () => setPickedFamily([]), className: "text-[10px] font-bold px-2 py-1 rounded-lg", style: { backgroundColor: "#334155", color: "#94a3b8" } }, t("msh"))),
                React.createElement("div", { className: "flex-1 overflow-y-auto px-3", style: { minHeight: 0 } },
                    familyMembers.length === 0 && (React.createElement("p", { className: "text-xs text-center mt-6", style: { color: "#475569" } }, t("la_ywjd_afrad_barqam"))),
                    familyMembers.map((m) => {
                        const on = pickedFamily.includes(m.id);
                        const late = isContactOverdue(m);
                        return (React.createElement("button", { key: m.id, onClick: () => setPickedFamily((p) => on ? p.filter((x) => x !== m.id) : [...p, m.id]), className: `w-full flex ${rowStart()} items-center gap-3 px-2 py-2.5 rounded-xl mb-1`, style: { backgroundColor: on ? colors.primary + "22" : "transparent" } },
                            React.createElement("span", { className: "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border-2", style: { borderColor: on ? colors.primary : "#475569", backgroundColor: on ? colors.primary : "transparent" } }, on && React.createElement(Check, { size: 11, color: "#fff" })),
                            React.createElement("div", { className: `flex-1 ${textStart()}`, style: { minWidth: 0 } },
                                React.createElement("p", { className: "text-xs font-bold text-white truncate" }, m.local_name),
                                React.createElement("p", { className: "text-[10px]", style: { color: late ? "#ef4444" : "#64748b" } },
                                    personKinLabel(m),
                                    late ? t("rm_takhr_altwasl") : ""))));
                    })),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 p-4 shrink-0`, style: { borderTop: "1px solid #334155" } },
                    React.createElement("button", { onClick: () => {
                            const chosen = familyMembers.filter((m) => pickedFamily.includes(m.id));
                            onInviteFamily === null || onInviteFamily === void 0 ? void 0 : onInviteFamily(chosen, roomLink);
                            showToast(t("arslt_aldawa_ila", { count: chosen.length }), "success");
                            setShowFamilyInvite(false);
                            setPickedFamily([]);
                        }, disabled: pickedFamily.length === 0, className: "flex-1 py-2.5 rounded-xl text-xs font-extrabold", style: { backgroundColor: pickedFamily.length ? colors.primary : "#334155", color: pickedFamily.length ? "#fff" : "#64748b" } },
                        t("rm_irsal_aldawa"),
                        pickedFamily.length,
                        ")"),
                    React.createElement("button", { onClick: () => setShowFamilyInvite(false), className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("ilgha")))))),
        showDurationPick && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowDurationPick(false), style: { position: "fixed", inset: 0, zIndex: 44, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 45, backgroundColor: "#1e293b", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 12 } },
                React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto my-3", style: { backgroundColor: "#334155" } }),
                React.createElement("p", { className: "text-white font-extrabold text-sm text-center mb-1" }, t("mda_alghrfa")),
                React.createElement("p", { className: "text-[11px] text-center mb-3", style: { color: "#94a3b8" } }, t("tghlq_alghrfa_tlqayya_and")),
                [{ v: 0, l: t("rm_bla_hd") }, { v: 30, l: t("rm_30_dqyqa") }, { v: 60, l: t("rm_saa") }, { v: 90, l: t("rm_saa_wnsf") }, { v: 120, l: t("rm_saatan") }].map((opt) => (React.createElement("button", { key: opt.v, onClick: () => {
                        setDurationLimit(opt.v);
                        setExpiryWarned(false);
                        setShowDurationPick(false);
                        showToast(opt.v ? t("rm_mda_alghrfa") + opt.l : t("rm_alghy_hd"), "success");
                    }, className: `w-full flex ${rowStart()} items-center gap-3 px-5 py-3.5`, style: { borderTop: "1px solid #334155" } },
                    React.createElement("span", { className: `flex-1 ${textStart()} text-sm font-bold`, style: { color: durationLimit === opt.v ? colors.primary : "#e2e8f0" } }, opt.l),
                    durationLimit === opt.v && React.createElement(Check, { size: 16, color: colors.primary }))))))),
        sendingTasks && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setSendingTasks(false), style: { position: "fixed", inset: 0, zIndex: 44, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 16, right: 16, top: "20%", bottom: "20%", zIndex: 45, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", display: "flex", flexDirection: "column" } },
                React.createElement("div", { className: "px-4 pt-4 pb-2 shrink-0" },
                    React.createElement("p", { className: "text-white font-extrabold text-sm text-center" }, t("irsal_almham_lmjmwaa")),
                    React.createElement("p", { className: "text-[11px] text-center mt-1", style: { color: "#94a3b8" } },
                        t("rm_stnsha_qayma"),
                        taskNotes.length,
                        t("rm_mhma_qabla"))),
                React.createElement("div", { className: "flex-1 overflow-y-auto px-3", style: { minHeight: 0 } }, groups.map((g) => {
                    var _a;
                    return (React.createElement("button", { key: g.id, onClick: () => {
                            onSendTasksToGroup === null || onSendTasksToGroup === void 0 ? void 0 : onSendTasksToGroup(g.id, t("rm_mham_ajtmaa") + new Date().toLocaleDateString(loc()), taskNotes.map((tn) => tn.text));
                            showToast(t("arslt", { count: taskNotes.length, group: g.name }), "success");
                            setSendingTasks(false);
                            setShowSummary(false);
                        }, className: `w-full flex ${rowStart()} items-center gap-3 px-2 py-2.5 rounded-xl mb-1` },
                        React.createElement("div", { className: "w-9 h-9 rounded-full flex items-center justify-center shrink-0", style: { backgroundColor: colors.primaryLight } },
                            React.createElement(Users2, { size: 17, color: colors.primaryDark })),
                        React.createElement("div", { className: `flex-1 ${textStart()}`, style: { minWidth: 0 } },
                            React.createElement("p", { className: "text-xs font-bold text-white truncate" }, g.name),
                            React.createElement("p", { className: "text-[10px]", style: { color: "#64748b" } },
                                ((_a = g.members) === null || _a === void 0 ? void 0 : _a.length) || 0,
                                t("rm_aada")))));
                })),
                React.createElement("div", { className: "p-4 shrink-0", style: { borderTop: "1px solid #334155" } },
                    React.createElement("button", { onClick: () => setSendingTasks(false), className: "w-full py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("ilgha")))))),
        showSummary && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowSummary(false), style: { position: "fixed", inset: 0, zIndex: 42, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 16, right: 16, top: "12%", bottom: "12%", zIndex: 43, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", display: "flex", flexDirection: "column" } },
                React.createElement("div", { className: "px-4 pt-4 pb-2 shrink-0" },
                    React.createElement("p", { className: "text-white font-extrabold text-sm text-center" }, t("mhdr_alajtmaa")),
                    React.createElement("p", { className: "text-[11px] text-center mt-1", style: { color: "#94a3b8" } },
                        mins,
                        ":",
                        secs,
                        " \u00B7 ",
                        participants.length,
                        t("rm_msharkyn_fasl"),
                        businessNotes.length,
                        t("rm_nqta_adad"))),
                React.createElement("div", { className: "flex-1 overflow-y-auto px-4 py-2", style: { minHeight: 0 } },
                    businessNotes.length === 0 && (React.createElement("p", { className: "text-xs text-center mt-6", style: { color: "#475569" } }, t("lm_tsjl_nqat_bad"))),
                    ["decision", "task", "point"].map((k) => {
                        const items = businessNotes.filter((m) => m.kind === k);
                        if (!items.length)
                            return null;
                        return (React.createElement("div", { key: k, className: "mb-4" },
                            React.createElement("p", { className: `text-[11px] font-extrabold mb-1.5 ${textStart()}`, style: { color: NOTE_KINDS[k].color } },
                                NOTE_KINDS[k].icon,
                                " ",
                                NOTE_KINDS[k].label,
                                " (",
                                items.length,
                                ")"),
                            items.map((m) => (React.createElement("div", { key: m.id, className: `rounded-xl px-3 py-2 mb-1.5 ${textStart()}`, style: { backgroundColor: "#0f172a", border: "1px solid #334155" } },
                                React.createElement("p", { className: "text-xs text-white leading-relaxed" }, m.text),
                                React.createElement("p", { className: "text-[9px] mt-1", style: { color: "#64748b" } },
                                    m.sender,
                                    " \u00B7 ",
                                    String(Math.floor(m.atSecond / 60)).padStart(2, "0"),
                                    ":",
                                    String(m.atSecond % 60).padStart(2, "0")))))));
                    })),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 p-4 shrink-0`, style: { borderTop: "1px solid #334155" } },
                    React.createElement("button", { onClick: exportSummary, disabled: businessNotes.length === 0, className: "flex-1 py-2.5 rounded-xl text-xs font-extrabold", style: { backgroundColor: businessNotes.length ? "#22C55E" : "#334155", color: businessNotes.length ? "#fff" : "#64748b" } }, t("tnzyl_almhdr")),
                    taskNotes.length > 0 && groups.length > 0 && (React.createElement("button", { onClick: () => setSendingTasks(true), className: "flex-1 py-2.5 rounded-xl text-xs font-extrabold", style: { backgroundColor: "#F59E0B", color: "#fff" } },
                        t("rm_arsl"),
                        taskNotes.length,
                        t("rm_mhma_wahda"))),
                    React.createElement("button", { onClick: () => setShowSummary(false), className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("ighlaq")))))),
        hostConfirm && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setHostConfirm(null), style: { position: "fixed", inset: 0, zIndex: 42, backgroundColor: "rgba(0,0,0,0.6)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 24, right: 24, top: "32%", zIndex: 43, backgroundColor: "#1e293b", borderRadius: 20, border: "1px solid #334155", padding: 20 } },
                React.createElement("p", { className: "text-white font-extrabold text-sm text-center mb-1" }, hostConfirm.action === "remove" ? t("rm_izala_sbq") + hostConfirm.p.name + t("rm_alama_sual") : t("rm_nql_alastdafa_s")),
                React.createElement("p", { className: "text-[11px] text-center mb-5 leading-relaxed", style: { color: "#94a3b8" } }, hostConfirm.action === "remove"
                    ? t("rm_sykhrj_mn_alghrfa")
                    : t("rm_sttnql_slahyat") + hostConfirm.p.name + t("rm_wln_tstty")),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("button", { onClick: () => {
                            if (hostConfirm.action === "remove")
                                removeParticipant(hostConfirm.p.id);
                            else
                                transferHost(hostConfirm.p.id);
                            setHostConfirm(null);
                        }, className: "flex-1 py-2.5 rounded-xl text-xs font-extrabold", style: { backgroundColor: hostConfirm.action === "remove" ? "#ef4444" : colors.primary, color: "#fff" } }, hostConfirm.action === "remove" ? t("rm_izala") : t("rm_nql")),
                    React.createElement("button", { onClick: () => setHostConfirm(null), className: "flex-1 py-2.5 rounded-xl text-xs font-bold", style: { backgroundColor: "#334155", color: "#e2e8f0" } }, t("ilgha")))))),
        floatingReactions.length > 0 && (React.createElement("div", { style: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 35 } }, floatingReactions.map((r) => (React.createElement("span", { key: r.id, className: "sawa-float-up", style: { position: "absolute", bottom: 110, left: r.left + "%", fontSize: 30 } }, r.emoji))))),
        showReactionBar && (React.createElement("div", { className: `mx-4 mb-2 rounded-2xl px-3 py-2 flex ${rowStart()} items-center justify-around`, style: { backgroundColor: "#1e293b", border: "1px solid #334155" } }, ROOM_REACTIONS.map((e) => (React.createElement("button", { key: e, onClick: () => sendReaction(e), style: { fontSize: 24 }, "aria-label": t("rm_tfaal") + e }, e))))),
        React.createElement("div", { className: "px-4 pb-5 pt-3", style: { backgroundColor: "#1e293b", borderTop: "1px solid #334155" } },
            React.createElement("div", { style: { display: "flex", flexDirection: "row", direction: "ltr", justifyContent: "space-around", alignItems: "center", marginBottom: 12 } },
                React.createElement("button", { onClick: () => setMyMic(!myMic), className: "flex flex-col items-center gap-1.5" },
                    React.createElement("div", { className: "w-13 h-13 rounded-full flex items-center justify-center", style: { width: 52, height: 52, backgroundColor: myMic ? "#334155" : "#ef4444" } }, myMic ? React.createElement(Mic, { size: 22, color: "#fff" }) : React.createElement(MicOff, { size: 22, color: "#fff" })),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: myMic ? "#94a3b8" : "#ef4444" } }, myMic ? t("rm_ktm") : t("rm_fth"))),
                React.createElement("button", { onClick: () => setMyCam(!myCam), className: "flex flex-col items-center gap-1.5" },
                    React.createElement("div", { className: "rounded-full flex items-center justify-center", style: { width: 52, height: 52, backgroundColor: myCam ? "#334155" : "#ef4444" } }, myCam ? React.createElement(Video, { size: 22, color: "#fff" }) : React.createElement(VideoOff, { size: 22, color: "#fff" })),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: myCam ? "#94a3b8" : "#ef4444" } }, myCam ? t("rm_iyqaf") : t("rm_tshghyl"))),
                React.createElement("button", { onClick: toggleHand, className: "flex flex-col items-center gap-1.5" },
                    React.createElement("div", { className: "rounded-full flex items-center justify-center", style: { width: 52, height: 52, backgroundColor: handRaised ? "#f59e0b33" : "#334155", border: handRaised ? "2px solid #f59e0b" : "2px solid transparent" } },
                        React.createElement("span", { style: { fontSize: 22 } }, "\u270B")),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: handRaised ? "#f59e0b" : "#94a3b8" } }, handRaised ? t("rm_inzal") : t("rm_ydy"))),
                React.createElement("button", { onClick: () => { setChatOpen(!chatOpen); if (!chatOpen)
                        setUnreadChat(0); }, className: "flex flex-col items-center gap-1.5" },
                    React.createElement("div", { className: "rounded-full flex items-center justify-center relative", style: { width: 52, height: 52, backgroundColor: chatOpen ? "#6366f133" : "#334155", border: chatOpen ? "2px solid #6366f1" : "2px solid transparent" } },
                        React.createElement(MessageCircle, { size: 22, color: chatOpen ? "#6366f1" : "#fff" }),
                        unreadChat > 0 && !chatOpen && (React.createElement("span", { className: "absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white", style: { backgroundColor: "#ef4444" } }, unreadChat))),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: chatOpen ? "#6366f1" : "#94a3b8" } }, t("drdsha"))),
                React.createElement("button", { onClick: () => setConfirmLeave(true), className: "flex flex-col items-center gap-1.5" },
                    React.createElement("div", { className: "rounded-full flex items-center justify-center", style: { width: 52, height: 52, backgroundColor: "#ef4444" } },
                        React.createElement(PhoneOff, { size: 22, color: "#fff" })),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#ef4444" } }, t("inha")))),
            React.createElement("div", { style: { display: "flex", flexDirection: "row", direction: "ltr", justifyContent: "center", gap: 12 } },
                React.createElement("button", { onClick: () => setShowReactionBar(!showReactionBar), className: "flex items-center gap-1.5 px-3 py-1.5 rounded-xl", style: { backgroundColor: showReactionBar ? "#334155" : "#1e293b", border: "1px solid #334155" } },
                    React.createElement("span", { style: { fontSize: 14 } }, "\uD83D\uDC4F"),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#94a3b8" } }, t("tfaal"))),
                React.createElement("button", { onClick: () => setShowQr(true), className: "flex items-center gap-1.5 px-3 py-1.5 rounded-xl", style: { backgroundColor: "#1e293b", border: "1px solid #334155" } },
                    React.createElement(QrCode, { size: 13, color: "#94a3b8" }),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#94a3b8" } }, "QR")),
                familyMembers.length > 0 && (React.createElement("button", { onClick: () => setShowFamilyInvite(true), className: "flex items-center gap-1.5 px-3 py-1.5 rounded-xl", style: { backgroundColor: "#1e293b", border: `1px solid ${"#6366f1"}44` } },
                    React.createElement("span", { style: { fontSize: 13 } }, "\uD83E\uDD0D"),
                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#6366f1" } }, t("rm_dawa_alaayla"))))))));
}
// === FirstRunScreen ===
function FirstRunScreen({ onStartFresh, onViewDemo }) {
    const { colors } = useTheme();
    const [firstName, setFirstName] = useState("");
    return (React.createElement("div", { className: "flex-1 flex flex-col", style: { backgroundColor: colors.bg } },
        React.createElement("div", { className: "flex flex-col items-center pt-12 pb-6 px-6", style: { background: "linear-gradient(160deg, " + (colors.primary) + "18, transparent)" } },
            React.createElement("div", { className: "w-20 h-20 rounded-3xl flex items-center justify-center mb-4", style: { background: "linear-gradient(135deg, " + (colors.primary) + ", " + (colors.primaryDark) + ")" } },
                React.createElement("span", { className: "text-4xl font-extrabold text-white" }, "\u0633\u0648\u0627")),
            React.createElement("h1", { className: "text-xl font-extrabold text-center mb-1", style: { color: colors.text } }, "\u0645\u0631\u062D\u0628\u0627\u064B \u0628\u0643 \u0641\u064A \u0633\u0648\u0627 \uD83E\uDD0D"),
            React.createElement("p", { className: "text-xs text-center", style: { color: colors.textMuted } }, "\u0627\u0628\u062F\u0623 \u0628\u0625\u0636\u0627\u0641\u0629 \u0623\u0648\u0644 \u0642\u0631\u064A\u0628 \u0644\u0643 \u2014 \u0648\u0633\u0648\u0627 \u064A\u062A\u0648\u0644\u0649 \u0627\u0644\u0628\u0627\u0642\u064A")),
        React.createElement("div", { className: "flex-1 px-6 pb-6" },
            React.createElement("div", { className: "rounded-2xl p-5 mb-4", style: { backgroundColor: colors.card, border: "1px solid " + (colors.primary) + "33" } },
                React.createElement("p", { className: "text-sm font-extrabold mb-3", style: { color: colors.text } }, "\u0627\u0628\u062F\u0623 \u0628\u0625\u0636\u0627\u0641\u0629 \u0623\u0648\u0644 \u0642\u0631\u064A\u0628 \u0644\u0643"),
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: firstName, onChange: (e) => setFirstName(e.target.value), placeholder: t("misc_aktb_asm"), className: "w-full border rounded-xl px-4 py-3 text-sm mb-4 outline-none", style: { borderColor: firstName ? colors.primary : colors.border, color: colors.text, backgroundColor: colors.bg }, autoFocus: true }),
                React.createElement("button", { onClick: () => firstName.trim() && onStartFresh(firstName.trim()), className: "w-full py-3 rounded-xl text-sm font-extrabold", style: {
                        backgroundColor: firstName.trim() ? colors.primary : colors.border,
                        color: "#fff",
                        opacity: firstName.trim() ? 1 : 0.5,
                    } },
                    "\u0627\u0628\u062F\u0623 \u0645\u0639 ",
                    firstName.trim() || "...")),
            React.createElement("div", { className: "flex items-center gap-3 my-4" },
                React.createElement("div", { className: "flex-1 h-px", style: { backgroundColor: colors.border } }),
                React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, "\u0623\u0648"),
                React.createElement("div", { className: "flex-1 h-px", style: { backgroundColor: colors.border } })),
            React.createElement("button", { onClick: onViewDemo, className: "w-full py-3 rounded-xl text-sm font-bold border", style: { borderColor: colors.border, color: colors.textMuted, backgroundColor: colors.card } }, "\u0627\u0633\u062A\u0639\u0631\u0636 \u0645\u062B\u0627\u0644 \u062A\u0648\u0636\u064A\u062D\u064A \u0623\u0648\u0644\u0627\u064B"),
            React.createElement("p", { className: "text-[10px] text-center mt-2", style: { color: colors.textMuted } }, "\u0628\u064A\u0627\u0646\u0627\u062A \u0648\u0647\u0645\u064A\u0629 \u0641\u0642\u0637 \u2014 \u0644\u0646 \u062A\u064F\u062D\u0641\u0638"))));
}

// === SawaTooltip ===
function SawaTooltip({ id, text, seen, onDismiss, position = "bottom" }) {
    const { colors } = useTheme();
    if (seen)
        return null;
    return (React.createElement("div", { className: "absolute z-50 left-4 right-4", style: { [position === "bottom" ? "top" : "bottom"]: "100%", marginTop: position === "bottom" ? 4 : 0, marginBottom: position === "top" ? 4 : 0 } },
        React.createElement("div", { className: "rounded-2xl px-4 py-3 shadow-lg relative", style: { backgroundColor: colors.primaryDark, maxWidth: 300, margin: "0 auto" } },
            React.createElement("p", { className: "text-xs text-white leading-relaxed" }, text),
            React.createElement("button", { onClick: onDismiss, className: "absolute top-2 left-2 w-5 h-5 flex items-center justify-center rounded-full", style: { backgroundColor: "rgba(255,255,255,0.2)" } },
                React.createElement(X, { size: 10, color: "#fff" })),
            React.createElement("div", { className: "absolute " + (position === "bottom" ? "-top-1.5" : "-bottom-1.5") + " left-1/2 -translate-x-1/2 w-3 h-3 rotate-45", style: { backgroundColor: colors.primaryDark } }))));
}

// === MatchCandidatesCard ===
function MatchCandidatesCard({ matchCandidates, matchDecisions, setMatchDecisions, textStart, rowStart, colors, t }) {
    if (matchCandidates.length === 0)
        return null;
    return (React.createElement(Card, { className: "mb-4", style: { borderColor: colors.accent } },
        React.createElement("div", { className: "flex " + rowStart() + " items-start gap-2 mb-3" },
            React.createElement(AlertTriangle, { size: 14, color: colors.accent, className: "mt-0.5 shrink-0" }),
            React.createElement("p", { className: "text-[11px] flex-1 " + textStart(), style: { color: colors.accent } }, t("hdhh_alasma_mwjwda_fy"))),
        matchCandidates.map((m) => (React.createElement("div", { key: m.low, className: "rounded-xl p-2.5 mb-2", style: { backgroundColor: colors.bg, border: "1px solid " + colors.border } },
            React.createElement("p", { className: "text-xs font-bold " + textStart() + " mb-0.5", style: { color: colors.text } }, m.typed),
            React.createElement("p", { className: "text-[10px] " + textStart() + " mb-2 leading-relaxed", style: { color: colors.textMuted } }, m.allMatches.length > 1
                ? t("ashkhas_bhdha_alasm", { length: m.allMatches.length, label: m.label })
                : "الموجود: " + m.label + (m.existing?.alive === false ? " (متوفّى)" : "")),
            m.allMatches.length > 1 && (React.createElement("p", { className: "text-[10px] " + textStart() + " mb-1.5", style: { color: colors.danger } }, t("tshabh_fy_alasm_takd"))),
            React.createElement("div", { className: "flex " + rowStart() + " gap-2" },
                React.createElement("button", { onClick: () => setMatchDecisions((d) => ({ ...d, [m.low]: "same" })), className: "flex-1 py-1.5 rounded-lg text-[10px] font-extrabold", style: {
                        backgroundColor: matchDecisions[m.low] === "same" ? colors.primary : colors.card,
                        color: matchDecisions[m.low] === "same" ? "#fff" : colors.text,
                        border: "1px solid " + (matchDecisions[m.low] === "same" ? colors.primary : colors.border),
                    } }, t("hw_nfsh")),
                React.createElement("button", { onClick: () => setMatchDecisions((d) => ({ ...d, [m.low]: "new" })), className: "flex-1 py-1.5 rounded-lg text-[10px] font-bold", style: {
                        backgroundColor: matchDecisions[m.low] === "new" ? colors.accent : colors.card,
                        color: matchDecisions[m.low] === "new" ? "#fff" : colors.text,
                        border: "1px solid " + (matchDecisions[m.low] === "new" ? colors.accent : colors.border),
                    } }, t("shkhs_akhr")))))),
        React.createElement("p", { className: "text-[10px] " + textStart() + " mt-1", style: { color: colors.textMuted } }, t("hw_nfsh_yrbt_alslsla"))));
}

// === HelpScreen ===
function HelpScreen({ onBack, onRestartTour }) {
    const { colors } = useTheme();
    const [openFaq, setOpenFaq] = useState(null);
    const WHY_CARDS = [
        { icon: "🎯", title: t("hp_q1"), body: t("hp_a1") },
        { icon: "🔥", title: t("hp_q2"), body: t("hp_a2") },
        { icon: "🔗", title: t("hp_q3"), body: t("hp_a3") },
        { icon: "💡", title: t("hp_q4"), body: t("hp_a4") },
        { icon: "📖", title: t("hp_q5"), body: t("hp_a5") },
    ];
    const FAQS = [
        { q: t("hp_q6"), a: t("hp_a6") },
        { q: t("hp_q7"), a: t("hp_a7") },
        { q: t("hp_q8"), a: t("hp_a8") },
        { q: t("hp_q9"), a: t("hp_a9") },
        { q: t("hp_q10"), a: t("hp_a10") },
        { q: t("hp_q11"), a: t("hp_a11") },
    ];
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("hp_dlyl"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            React.createElement("p", { className: "text-xs font-extrabold mb-3", style: { color: colors.textMuted } }, t("hp_fhm")),
            WHY_CARDS.map((card, i) => (React.createElement("div", { key: i, className: "rounded-2xl p-4 mb-3", style: { backgroundColor: colors.card, border: "1px solid " + (colors.border) } },
                React.createElement("div", { className: "flex " + (rowStart()) + " items-center gap-2 mb-1.5" },
                    React.createElement("span", { className: "text-xl" }, card.icon),
                    React.createElement("span", { className: "text-sm font-extrabold", style: { color: colors.text } }, card.title)),
                React.createElement("p", { className: "text-xs leading-relaxed " + (textStart()), style: { color: colors.textMuted } }, card.body)))),
            React.createElement("p", { className: "text-xs font-extrabold mb-3 mt-4", style: { color: colors.textMuted } }, t("hp_asyla")),
            FAQS.map((faq, i) => (React.createElement("div", { key: i, className: "rounded-2xl mb-2 overflow-hidden", style: { backgroundColor: colors.card, border: "1px solid " + (colors.border) } },
                React.createElement("button", { onClick: () => setOpenFaq(openFaq === i ? null : i), className: "w-full flex " + (rowStart()) + " items-center justify-between p-4" },
                    React.createElement("span", { className: "text-sm font-bold " + (textStart()) + " flex-1", style: { color: colors.text } }, faq.q),
                    React.createElement(ChevronLeft, { size: 14, color: colors.textMuted, style: { transform: openFaq === i ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform 0.2s", flexShrink: 0 } })),
                openFaq === i && (React.createElement("div", { className: "px-4 pb-4 text-xs leading-relaxed " + (textStart()), style: { color: colors.textMuted } }, faq.a))))),
            React.createElement("div", { className: "mt-4 mb-2" },
                React.createElement("button", { onClick: onRestartTour, className: "w-full py-3 rounded-xl text-sm font-extrabold", style: { backgroundColor: colors.primaryLight, color: colors.primary } }, t("hp_abda_aljwla"))))));
}
function OnboardingScreen({ onDone }) {
    const { colors } = useTheme();
    const [idx, setIdx] = useState(0);
    const slide = ONBOARDING_SLIDES[idx];
    const isLast = idx === ONBOARDING_SLIDES.length - 1;
    return (React.createElement("div", { className: "flex-1 flex flex-col overflow-y-auto", style: { backgroundColor: colors.bg } },
        React.createElement("div", { className: "flex justify-end p-3" },
            React.createElement("button", { onClick: onDone, className: "text-xs font-bold", style: { color: colors.textMuted } }, t("tkhty"))),
        React.createElement("div", { className: "flex flex-col items-center justify-center p-8" },
            idx === 0 ? (React.createElement("img", { src: IS_RAHIM ? APP_LOGO_RAHIM : SAWA_LOGO, alt: t("shaar_swa"), style: { width: 120, height: 120, objectFit: "contain", marginBottom: 20 } })) : (React.createElement("div", { className: "w-20 h-20 rounded-full flex items-center justify-center mb-5", style: { backgroundColor: colors.primaryLight } }, React.createElement(slide.icon, { size: 36, color: colors.primary }))),
            React.createElement("h2", { className: "text-lg font-extrabold text-center mb-2", style: { color: colors.text } }, t(slide.titleKey)),
            React.createElement("p", { className: "text-sm text-center", style: { color: colors.textMuted } }, t(slide.bodyKey))),
        React.createElement("div", { className: `flex ${rowStart()} justify-center gap-1.5 pb-4` }, ONBOARDING_SLIDES.map((_, i) => (React.createElement("span", { key: i, className: "rounded-full", style: { width: i === idx ? 18 : 6, height: 6, backgroundColor: i === idx ? colors.primary : colors.border, transition: "width 0.2s" } })))),
        React.createElement("div", { className: "p-4" },
            React.createElement(Button, { label: isLast ? t("mnw_abda_alan") : t("altaly"), onPress: () => (isLast ? onDone() : setIdx((i) => i + 1)) }))));
}
// ============================================================
// ملاحظات المجرِّبين — تُرسَل عبر واتساب لا تُخزَّن محلياً.
//
// لا خادم بعد، فالملاحظة المحفوظة على جهاز المجرِّب لا تصل أحداً.
// الحل: نبني نصاً جاهزاً ونفتح به واتساب. إن تعذّر (لا رقم مضبوط
// أو حاسوب بلا واتساب) نرجع إلى مشاركة النظام ثم النسخ.
//
// السياق التقني يُرفَق تلقائياً — لأن المجرِّب لا يعرف نسخته ولا
// جهازه، وبدونها يصعب تتبّع البلاغ.
// ============================================================
function FeedbackSheet({ onClose, currentScreen = "" }) {
    const { colors } = useTheme();
    const showToast = useToast();
    const [kind, setKind] = useState(null);
    const [text, setText] = useState("");
    const [feeling, setFeeling] = useState(null);
    const [sent, setSent] = useState(false);
    const kinds = [
        { k: "bug", label: t("fb_la_yaml"), hint: t("fb_atl_aw_khta") },
        { k: "idea", label: t("fb_aqtrah"), hint: t("fb_ttmna_wjwdh") },
        { k: "confuse", label: t("fb_ghyr_wadh"), hint: t("fb_lm_tfhm") },
        { k: "praise", label: t("fb_ajbk"), hint: t("fb_wjdth_mfyda") },
    ];
    // السؤال المحوري: هل التذكيرات مُقدَّرة أم مزعجة؟
    // يُسأل مرة واحدة ضمن نموذج الملاحظات لا كإشعار منفصل، لأن
    // المقاطعة بسؤال مستقل تُنفّر — والإجابة هنا اختيارية.
    const feelings = [
        { k: "caring", label: t("fb_alahtmam") },
        { k: "neutral", label: t("fb_aadya") },
        { k: "guilt", label: t("fb_aldhnb") },
        { k: "annoy", label: t("fb_mzaja") },
    ];
    function buildMessage() {
        const k = kinds.find((x) => x.k === kind);
        const f = feelings.find((x) => x.k === feeling);
        const lines = [
            t("fb_anwan_alrsala"),
            "",
            `النوع: ${k ? k.label : t("fb_ghyr_mhdd")}`,
            "",
            text.trim(),
        ];
        if (f)
            lines.push("", t("an_tdhkyrat_sla_alrhm", { label: f.label }));
        lines.push("", "───────────", t("alnskha", { APP_VERSION: (function () { try { return (localStorage.getItem("sawa_build") || SAWA_BUILD) + (window.SawaChat && window.SawaChat.version ? " · " + window.SawaChat.version : ""); } catch (e) { return APP_VERSION; } })() }), currentScreen ? t("alshasha", { currentScreen }) : null, `التاريخ: ${new Date().toLocaleDateString(loc())}`);
        return lines.filter((l) => l !== null).join("\n");
    }
    function send() {
        if (!text.trim()) {
            showToast(t("aktb_mlahztk_awla"), "error");
            return;
        }
        const msg = buildMessage();
        // ١. واتساب مباشرةً إن ضُبط الرقم
        if (FEEDBACK_WHATSAPP) {
            try {
                window.open(`https://wa.me/${FEEDBACK_WHATSAPP}?text=${encodeURIComponent(msg)}`, "_blank");
                setSent(true);
                return;
            }
            catch (_a) { }
        }
        // ٢. مشاركة النظام — يختار المستخدم واتساب أو غيره
        const shared = shareText({ title: t("fb_mlahza_ala_swa"), text: msg });
        // ٣. shareText ينسخ تلقائياً عند الفشل
        showToast(shared ? t("fb_akhtr_watsab") : t("fb_nskht_almlahza"));
        setSent(true);
    }
    if (sent) {
        return (React.createElement("div", { className: "absolute inset-0 z-50 flex items-center justify-center p-6", style: { backgroundColor: "rgba(0,0,0,0.5)" }, onClick: onClose },
            React.createElement("div", { className: "w-full rounded-2xl", style: { backgroundColor: colors.card }, onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "p-6 text-center" },
                    React.createElement("div", { className: "rounded-full mx-auto flex items-center justify-center mb-3", style: { width: 56, height: 56, backgroundColor: colors.primaryLight } },
                        React.createElement(Check, { size: 26, color: colors.primary })),
                    React.createElement("p", { className: "text-sm font-extrabold mb-1", style: { color: colors.text } }, t("shkra_lk")),
                    React.createElement("p", { className: "text-xs mb-5", style: { color: colors.textMuted } }, t("mlahztk_tsna_alfrq_kl")),
                    React.createElement("button", { onClick: onClose, className: "w-full rounded-xl py-3 text-xs font-extrabold", style: { backgroundColor: colors.primary, color: "#fff" } }, t("ighlaq"))))));
    }
    return (React.createElement("div", { className: "absolute inset-0 z-50 flex items-end justify-center", style: { backgroundColor: "rgba(0,0,0,0.5)" }, onClick: onClose },
        React.createElement("div", { className: "w-full rounded-t-2xl max-h-[92%] overflow-y-auto", style: { backgroundColor: colors.card }, onClick: (e) => e.stopPropagation() },
            React.createElement("div", { className: "p-4" },
                React.createElement("p", { className: `text-sm font-extrabold mb-1 ${textStart()}`, style: { color: colors.text } }, t("mlahzatk_thmna")),
                React.createElement("p", { className: `text-[11px] mb-4 ${textStart()}`, style: { color: colors.textMuted } }, t("swa_fy_mrhla_altjrba")),
                React.createElement("div", { className: "grid grid-cols-2 gap-2 mb-4" }, kinds.map((k) => (React.createElement("button", { key: k.k, onClick: () => setKind(k.k), className: `rounded-xl p-2.5 ${textStart()}`, style: {
                        backgroundColor: kind === k.k ? colors.primaryLight : colors.card,
                        border: `1.5px solid ${kind === k.k ? colors.primary : colors.border}`,
                    } },
                    React.createElement("p", { className: "text-[11px] font-extrabold", style: { color: kind === k.k ? colors.primaryDark : colors.text } }, k.label),
                    React.createElement("p", { className: "text-[9px] mt-0.5", style: { color: colors.textMuted } }, k.hint))))),
                React.createElement("label", { className: `text-[11px] font-extrabold mb-1.5 block ${textStart()}`, style: { color: colors.text } }, t("ma_aldhy_tryd_ikhbarna")),
                React.createElement("textarea", { dir: isRTL() ? "rtl" : "ltr", value: text, onChange: (e) => setText(e.target.value), rows: 4, placeholder: t("aktb_bhrya_la_haja"), className: `w-full rounded-xl px-3 py-2.5 text-xs outline-none mb-4 ${textStart()}`, style: { backgroundColor: colors.card, border: `1px solid ${colors.border}`, color: colors.text } }),
                React.createElement("div", { className: "rounded-xl p-3 mb-4", style: { backgroundColor: colors.card, border: `1px dashed ${colors.border}` } },
                    React.createElement("p", { className: `text-[11px] font-extrabold mb-0.5 ${textStart()}`, style: { color: colors.text } }, t("swal_wahd_in_smht")),
                    React.createElement("p", { className: `text-[10px] mb-2.5 ${textStart()}`, style: { color: colors.textMuted } }, t("tdhkyrat_sla_alrhm_kyf")),
                    React.createElement("div", { className: `flex ${rowStart()} flex-wrap gap-1.5` }, feelings.map((f) => (React.createElement("button", { key: f.k, onClick: () => setFeeling(feeling === f.k ? null : f.k), className: "rounded-full px-2.5 py-1 text-[10px] font-bold", style: {
                            backgroundColor: feeling === f.k ? colors.primary : "transparent",
                            color: feeling === f.k ? "#fff" : colors.textMuted,
                            border: `1px solid ${feeling === f.k ? colors.primary : colors.border}`,
                        } }, f.label))))),
                React.createElement("button", { onClick: send, disabled: !text.trim(), className: `w-full rounded-xl py-3 flex ${rowStart()} items-center justify-center gap-2`, style: {
                        backgroundColor: text.trim() ? colors.primary : colors.border,
                        opacity: text.trim() ? 1 : 0.6,
                    } },
                    React.createElement(Send, { size: 15, color: "#fff" }),
                    React.createElement("span", { className: "text-xs font-extrabold", style: { color: "#fff" } }, t("irsal_almlahza"))),
                React.createElement("p", { className: "text-[9px] text-center mt-2", style: { color: colors.textMuted } }, t("tfth_rsala_jahza_trajaha"))))));
}
function ContributionAmountModal({ onConfirm, onClose, walletBalance }) {
    const { colors } = useTheme();
    const [amount, setAmount] = useState("");
    const [useWallet, setUseWallet] = useState(false);
    const numAmount = Number(amount);
    const canUseWallet = walletBalance != null && walletBalance > 0;
    const walletInsufficient = useWallet && numAmount > (walletBalance || 0);
    return (React.createElement("div", { className: "absolute inset-0 z-50 flex flex-col items-center justify-center p-6", style: { backgroundColor: "rgba(0,0,0,0.5)" } },
        React.createElement("div", { className: "w-full rounded-2xl p-4", style: { backgroundColor: colors.card } },
            React.createElement("p", { className: "text-sm font-bold text-center mb-3", style: { color: colors.text } }, t("km_thb_ttbra")),
            React.createElement("input", { dir: "ltr", value: amount, onChange: (e) => setAmount(e.target.value.replace(/\D/g, "")), placeholder: t("almblgh_j_s"), inputMode: "numeric", className: "w-full border rounded-xl px-3 py-3 text-center text-lg font-bold mb-3", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.bg }, autoFocus: true }),
            canUseWallet && (React.createElement("button", { onClick: () => setUseWallet((v) => !v), className: `w-full flex ${rowStart()} items-center gap-2 rounded-xl px-3 py-2 mb-3 border`, style: { borderColor: useWallet ? colors.primary : colors.border, backgroundColor: useWallet ? colors.primary + "15" : "transparent" } },
                React.createElement(Wallet, { size: 14, color: useWallet ? colors.primary : colors.textMuted }),
                React.createElement("span", { className: "text-xs font-bold flex-1", style: { color: useWallet ? colors.primary : colors.text } }, t("mhfza_swa")),
                React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } },
                    (walletBalance || 0).toLocaleString(loc()),
                    " \u062C.\u0633"),
                React.createElement("div", { className: "w-4 h-4 rounded flex items-center justify-center", style: { backgroundColor: useWallet ? colors.primary : "transparent", border: `1px solid ${useWallet ? colors.primary : colors.border}` } }, useWallet && React.createElement(Check, { size: 10, color: "#fff" })))),
            walletInsufficient && (React.createElement("p", { className: "text-[10px] text-center mb-2", style: { color: colors.danger } }, t("alrsyd_ghyr_kaf"))),
            React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                React.createElement(Button, { label: t("tbra_alan"), disabled: !amount || numAmount <= 0 || walletInsufficient, onPress: () => onConfirm(numAmount, useWallet), style: { flex: 1 } }),
                React.createElement(Button, { label: t("ilgha"), variant: "outline", onPress: onClose, style: { flex: 1 } })))));
}
function AppInner() {
    var _a, _b, _c, _d, _e, _f;
    const { colors } = useTheme();
    const { showToast } = useToast();
    // تنبيه واحد عند امتلاء التخزين — أفضل من فقدان صامت للبيانات
    useEffect(() => {
        const onFull = () => showToast(t("msaha_altkhzyn_mmtlya_bad"), "error");
        window.addEventListener("sawa:storage-full", onFull);
        return () => window.removeEventListener("sawa:storage-full", onFull);
    }, [showToast]);
    const [flow, setFlow] = useState("app");
    const [isDemoMode, setIsDemoMode] = useState(false);
    const [seenTooltips, setSeenTooltips] = usePersistedState("seenTooltips", {});
    const [showHelp, setShowHelp] = useState(false);
    function markTooltipSeen(key) { setSeenTooltips(function(p){return Object.assign({},p,{[key]:true});}); }
    function resetTooltips() { setSeenTooltips({}); } // onboarding | setup | locked | forgot | postRecoveryCodes | app
    const [pin, setPin] = useState(null);
    const [recoveryCodes, setRecoveryCodes] = useState([]);
    const [biometricEnabled, setBiometricEnabled] = useState(false);
    const [statusOption, setStatusOption] = usePersistedState("statusOption", "online");
    const [customStatusMessage, setCustomStatusMessage] = useState("");
    const [profilePhoto, setProfilePhoto] = usePersistedState("profilePhoto", null);
    const [interfaceLanguage, setInterfaceLanguage] = useState(() => {
        try {
            return localStorage.getItem("sawaLang") || window.__SAWA_LANG || "ar";
        }
        catch (e) {
            return "ar";
        }
    });
    // setLocale يكتب في window، وReact لا يراه. المفتاح على الغلاف
    // يجبر إعادة بناء الشجرة كاملة فتُقرأ الاتجاهات والنصوص من جديد.
    React.useEffect(() => { setLocale(interfaceLanguage); }, [interfaceLanguage]);
    const [pinLockEnabled, setPinLockEnabled] = useState(true);
    const [browserNotifEnabled, setBrowserNotifEnabled] = useState(false);
    const [blockUnsolicited, setBlockUnsolicited] = useState(true);
    const [identityVerified, setIdentityVerified] = useState(false);
    const [chatBackupEnabled, setChatBackupEnabled] = usePersistedState("chatBackup", false);
    const [chatFolders, setChatFolders] = usePersistedState("chatFolders", []);
    const [folderAssignments, setFolderAssignments] = usePersistedState("folderAssignments", {});
    const [defaultNotificationTone, setDefaultNotificationTone] = useState("default");
    const [conversationTones, setConversationTones] = useState({});
    function addChatFolder(name) {
        setChatFolders((prev) => [...prev, { id: `folder-${Date.now()}`, name }]);
        showToast(t("tm_insha_mjld", { name }), "success");
    }
    function deleteChatFolder(id) {
        setChatFolders((prev) => prev.filter((f) => f.id !== id));
        setFolderAssignments((prev) => {
            const next = { ...prev };
            Object.keys(next).forEach((key) => { if (next[key] === id)
                delete next[key]; });
            return next;
        });
        showToast(t("tm_hdhf_almjld"), "success");
    }
    function assignConversationFolder(conversationId, folderId) {
        setFolderAssignments((prev) => ({ ...prev, [conversationId]: folderId }));
    }
    const [redeemedReferralCode, setRedeemedReferralCode] = useState(null);
    function redeemReferral(code) {
        setRedeemedReferralCode(code);
        setWalletBalance((prev) => prev + REFERRAL_REWARD_SDG);
        setWalletTransactions((prev) => [{ id: `w-${Date.now()}`, type: "credit", amount: REFERRAL_REWARD_SDG, note: t("mkafaa_dawa_astkhdam_rmz", { code }), ts: Date.now() }, ...prev]);
    }
    // يستخدم إذن الإشعارات الفعلي للمتصفح — طلب حقيقي، مو محاكاة
    function toggleBrowserNotif() {
        // C5: على السحابة الإشعارات حقيقيّة (FCM) — التفعيل/الإيقاف عبر SawaChat
        const SCn = window.SawaChat;
        if (SCn && SCn.enabled && SCn.enabled() && SCn.enablePush) {
            if (browserNotifEnabled) { SCn.disablePush(); setBrowserNotifEnabled(false); showToast("🔕", "success"); return; }
            SCn.enablePush().then((ok) => setBrowserNotifEnabled(!!ok));
            return;
        }
        if (browserNotifEnabled) {
            setBrowserNotifEnabled(false);
            return;
        }
        if (!("Notification" in window)) {
            showToast(t("mtsfhk_ma_ydam_alishaarat"), "error");
            return;
        }
        Notification.requestPermission().then((perm) => {
            if (perm === "granted") {
                setBrowserNotifEnabled(true);
                showToast(t("tm_tfayl_ishaarat_almtsfh"), "success");
            }
            else
                showToast(t("ma_wafqt_ala_idhn"), "error");
        });
    }
    const [autoLockDelay, setAutoLockDelay] = useState(0);
    const [tab, setTab] = useState(IS_RAHIM ? "discover" : "chats");   // C13e: التطبيق يفتح على المحادثات
    const [stack, setStack] = useState([]); // 'security' | 'demo' | 'sessions' | 'wallet' | 'stats' | 'notifications'
    const [notes, setNotes] = useState([]);
    // ⛔ كانت ثلاثة إشعارات مكتوبةً في الكود: «أشار لك خالد» و«ذكرى ميلاد
    // جدك» و«حان وقت الاتصال بأبوي» — لا علاقة لها بشجرة أحد. ومع ذلك
    // كانت تُنادى t() داخل useState، فتتجمّد على لغة الإقلاع.
    // ⛔ وتُحفظ الآن: ختمُ «أُشعِر هذا العام» كان يُحفظ والقائمة لا، فيظهر
    // تنبيه الميلاد مرّةً ثمّ يختفي بإعادة التحميل ولا يعود ذلك العام.
    const [notifications, setNotifications] = usePersistedState("notifications", []);
    function markNotificationRead(id) {
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    }
    // محاكاة Geofencing — التتبّع الفعلي بالخلفية يحتاج مكتبة native وجهاز
    // حقيقي، فهذا زر "محاكاة" يولّد تنبيه قرب بنفس شكل الحقيقي بالضبط، لتجربة
    // سلوك المستخدم بدون GPS فعلي — نفس الفكرة الموثّقة بالتطبيق الأصلي
    function simulateProximity(personId, personName) {
        const newNotif = { id: `n-prox-${Date.now()}`, type: "proximity", title: t("tnbyh_alqrb_anwan"), body: t("tnbyh_alqrb_ns", { personName }), read: false };
        setNotifications((prev) => [newNotif, ...prev]);
        showToast(t("tm_irsal_tnbyh_alqrb"), "success");
    }
    // ------------------------------- صلة الرحم -------------------------------
    // ⛔ كانت useState: كلّ مجموعة تُنشئها تختفي عند إعادة التحميل بينما
    // يبقى أشخاصها وصلاتهم في groupPersons و kinshipRelations بلا مجموعة
    // تحويهم — بياناتٌ يتيمة لا سبيل إليها.
    const [familyGroups, setFamilyGroups] = usePersistedState("familyGroups", initialFamilyGroups);
    const [groupPersons, setGroupPersons] = usePersistedState("groupPersons", initialGroupPersons);
    // ── ترحيل لمرّة واحدة ────────────────────────────────────────────
    // نسخ سابقة كانت تُخزّن صلة القرابة مترجَمة: من أضاف سلسلة نسب
    // والواجهة إنجليزية حُفظ عنده «Forebear (4)» بدل المُعرِّف العربي،
    // فظهرت إنجليزية في الواجهة العربية إلى الأبد. نُعيدها لمُعرِّفها.
    React.useEffect(() => {
        setGroupPersons((prev) => {
            let touched = false;
            const out = {};
            Object.keys(prev || {}).forEach((gid) => {
                out[gid] = (prev[gid] || []).map((p) => {
                    const m = /^Forebear \((\d+)\)$/.exec(p && p.kinship ? p.kinship : "");
                    if (!m)
                        return p;
                    touched = true;
                    return { ...p, kinship: `سلف (${m[1]})` }; // ⛔ مُعرِّف
                });
            });
            return touched ? out : prev;
        });
    }, []);
    // ⛔ كانت useState: المجموعة «الحالية» ترجع إلى g-1 عند كل إعادة تحميل،
    // ولو حُذفت لبقي المؤشّر عليها. الحذف لا يصحّ بلا حفظها.
    const [currentGroupId, setCurrentGroupId] = usePersistedState("currentGroupId", "g-1");
    const [familyFavorites, setFamilyFavorites] = useState({});
    const [schedules, setSchedules] = usePersistedState("schedules", initialSchedules);
    // groupSchedules مفهرس بـ groupId للتمرير لـ FamilyReminderCard
    const groupSchedules = schedules.reduce((acc, s) => {
        if (!acc[s.groupId])
            acc[s.groupId] = [];
        acc[s.groupId].push(s);
        return acc;
    }, {});
    // تحقّق تلقائي عند فتح التطبيق: أي موعد تواصل استحق فعلياً (dueTimestamp
    // انقضى) يولّد إشعاراً حقيقياً بمركز الإشعارات — بدل ما تحتاج تدخل شاشة
    // "مواعيد" بنفسك لتكتشف الاستحقاق. يشتغل مرة وحدة عند التحميل (محاكاة
    // لما كان بيصير بالخلفية على السيرفر بتطبيق حقيقي)
    // C75: أُزيل تنبيهٌ ثانٍ للمواعيد كان يكرّر الإشعار نفسه (n-sched) ولا يتجدّد في الدورة التالية — الذي يليه يكفي.

    // تحقّق تلقائي حقيقي لأعياد الميلاد القريبة (خلال 3 أيام) — إشعار استباقي
    // فعلي بدون ما تحتاج تفتح شاشة الاقتراحات لتكتشفه. نتتبّع سنة آخر إشعار
    // لكل قريب (notifiedBirthdayYear) عشان ما نكرّر نفس التنبيه بنفس السنة
    useEffect(() => {
        // C75: منتصف الليل لا «الآن» — وإلّا عُدّ عيد ميلاد اليوم ماضياً فانتقل إلى السنة القادمة ولم يُنبَّه به
        const now0 = new Date(), today = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate());
        const newNotifs = [];
        const toMark = []; // { groupId, personId, year }
        const dueMark = []; // معرّفات المواعيد التي أُشعِر بها في دورتها هذه
        Object.entries(groupPersons).forEach(([groupId, persons]) => {
            persons.forEach((p) => {
                if (!p.alive || !p.birthday || isSelfPerson(p))
                    return;
                const [bMonth, bDay] = String(p.birthday).split("-").map(Number);
                const thisYearBday = new Date(today.getFullYear(), bMonth - 1, bDay);
                if (thisYearBday < today)
                    thisYearBday.setFullYear(today.getFullYear() + 1);
                const daysUntil = Math.ceil((thisYearBday - today) / (1000 * 60 * 60 * 24));
                const targetYear = thisYearBday.getFullYear();
                if (daysUntil <= 3 && p.notifiedBirthdayYear !== targetYear) {
                    newNotifs.push({
                        id: `n-bday-${p.id}-${targetYear}`, type: "event",
                        title: daysUntil === 0 ? t("ai_ayd_alywm") : t("ai_ayd_qryb"),
                        body: daysUntil === 0 ? t("alywm_ayd_mylad_la", { local_name: p.local_name }) : t("ayd_mylad_bad_ywm", { local_name: p.local_name, daysUntil }),
                        read: false,
                    });
                    toMark.push({ groupId, personId: p.id, year: targetYear });
                }
            });
        });
        // المواعيد المستحقّة — تنبيهٌ واحد لكلّ دورة استحقاق لا لكلّ فتح
        schedules.forEach((sc) => {
            if (typeof sc.dueTimestamp !== "number" || sc.dueTimestamp > Date.now() + DAY_MS)
                return;
            if (sc.notifiedDueTs === sc.dueTimestamp)
                return;
            const p = (groupPersons[sc.groupId] || []).find((x) => x.id === sc.personId);
            if (!p || !p.alive)
                return;
            newNotifs.push({
                id: `n-sch-${sc.id}-${sc.dueTimestamp}`, type: "schedule",
                title: t("ai_mwad_mstihq"),
                body: t("ntf_mwad_body", { action: actionLabel(sc.action), name: p.local_name }),
                read: false,
            });
            dueMark.push(sc.id);
        });
        if (dueMark.length)
            setSchedules((prev) => prev.map((sc) => (dueMark.indexOf(sc.id) !== -1
                ? Object.assign({}, sc, { notifiedDueTs: sc.dueTimestamp })
                : sc)));
        if (newNotifs.length === 0)
            return;
        // ⛔ سقفٌ للقائمة: تُحفظ الآن فتتراكم بلا حدّ لولاه
        setNotifications((prev) => [...newNotifs, ...prev].slice(0, 50));
        setGroupPersons((prev) => {
            const next = { ...prev };
            toMark.forEach(({ groupId, personId, year }) => {
                next[groupId] = (next[groupId] || []).map((p) => (p.id === personId ? { ...p, notifiedBirthdayYear: year } : p));
            });
            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [events, setEvents] = usePersistedState("events", initialEvents);
    // ⛔ كانت useState بينما createFamilyGroup يكتب إليها: مجموعةٌ تُنشأ
    // تفقد أعضاءها وإعداداتها عند إعادة التحميل.
    const [members, setMembers] = usePersistedState("members", initialMembers);
    const [kinshipRelations, setKinshipRelations] = usePersistedState("kinshipRelations", initialKinship);
    // C75: «من أنا في هذه الشجرة؟» لكلّ عائلة على هذا الجهاز — صاحب الشجرة هو «نفسي»، ومن انضمّ يختار نفسه.
    const [famMe, setFamMe] = usePersistedState("famMe", {});
    // C75: القرابة المحسوبة من الصلات لكلّ عائلة (للعرض والتذكير). ما يُكتب يبقى في groupPersons كما هو.
    const famPersons = useMemo(() => {
        const out = {};
        Object.keys(groupPersons || {}).forEach((gid) => {
            const list = groupPersons[gid] || [];
            const rels = kinshipRelations.filter((r) => r.groupId === gid);
            const ownerSelf = list.find(isSelfPerson);
            // من انضمّ ولم يختر نفسه بعد: إن طابق اسمُ حسابه شخصاً واحداً في الشجرة فهو هو (يستطيع التغيير)
            const g = (familyGroups || []).find((x) => x.id === gid);
            let guess = null;
            if (g && g.role && g.role !== "owner" && !famMe[gid]) {
                const nm = normalizeArabicName(myAccountName() || "");
                const hits = nm ? list.filter((p) => normalizeArabicName(p.local_name) === nm || normalizeArabicName(String(p.local_name).split(" ")[0]) === nm) : [];
                if (hits.length === 1 && !isSelfPerson(hits[0])) guess = hits[0].id;
            }
            const meId = (famMe[gid] && list.some((p) => p.id === famMe[gid])) ? famMe[gid] : (guess || (ownerSelf && ownerSelf.id));
            let kin = {};
            try { kin = meId ? kinCompute(list, rels, meId) : {}; } catch (e) { kin = {}; }
            out[gid] = list.map((p) => {
                const k = kin[p.id];
                if (p.id === meId) return { ...p, kinship: SELF_KINSHIP, kinLabel: null, kinAlso: [], kinComputed: true, kinStored: p.kinship, kinSection: "self" };
                if (!k) return (ownerSelf && meId !== ownerSelf.id && p.id === ownerSelf.id) ? { ...p, kinship: "أخرى", kinStored: p.kinship } : p;
                return { ...p, kinship: k.kinship, kinLabel: k.label !== k.kinship ? k.label : null, kinAlso: k.also, proximity: k.proximity, kinSection: k.section, kinComputed: true, kinStored: p.kinship };
            });
        });
        return out;
    }, [groupPersons, kinshipRelations, famMe, familyGroups]);
    const [activityLog, setActivityLog] = usePersistedState("famActivityLog", []); // { id, groupId, text, ts } — C75: يُحفظ (كان يضيع عند كلّ فتح فيبدو السجلّ فارغاً دائماً)
    const [groupSettings, setGroupSettings] = usePersistedState("groupSettings", initialSettings);
    // الجسر (B5): يُعطي sawa-sync.js مُحدِّثات الحالة ليطبّق بيانات الخادم (القراءة، الاستعادة، الانضمام)
    useEffect(() => { if (window.SawaSync && window.SawaSync.bindApp) window.SawaSync.bindApp({ setFamilyGroups, setGroupPersons, setKinshipRelations, setCurrentGroupId, setGroupSettings, setMembers, setEvents, setSchedules }); }, []);
    // الجسر (B4/B5): كلّ تغيّرٍ يُرسَل فرقُه للخادم (المجموعات المرفوعة فقط)، ويُبلَّغ بالمجموعة الحاليّة لمراقبتها
    useEffect(() => { if (window.SawaSync && window.SawaSync.observe) window.SawaSync.observe(groupPersons, kinshipRelations, currentGroupId, familyGroups, events, schedules); }, [groupPersons, kinshipRelations, currentGroupId, familyGroups, events, schedules]);
    // ⛔ كانت useState: كلّ سؤالٍ تجاهلتَه يعود عند إعادة التحميل. ويزداد
    // الأمر ثقلاً بأسئلة الوالدين، فهي تُطرح لكلّ من لا أبَ له.
    const [dismissedSuggestions, setDismissedSuggestions] = usePersistedState("dismissedSuggestions", {});
    const [discoverStack, setDiscoverStack] = useState([]); // كل عنصر: {type, data}
    const [momentsReturnTab, setMomentsReturnTab] = useState(null); // التبويب الذي فُتحت منه اللحظات
    const [showAddSchedule, setShowAddSchedule] = useState(false);
    const [editingSchedule, setEditingSchedule] = useState(null);
    const [editingEvent, setEditingEvent] = useState(null);
    const [preselectedSchedulePersonId, setPreselectedSchedulePersonId] = useState(null);
    const [showAddEvent, setShowAddEvent] = useState(false);
    const [gapAddPreset, setGapAddPreset] = useState(null);
    const [bulkAddPreset, setBulkAddPreset] = useState(null); // {groupId, person, startRel} // null | { groupId, relatedToId, relationType }
    // ------------------------------- ربط الباك اند -------------------------------
    const [backendLinked, setBackendLinked] = useState(true); // وضع تجربة محلية
    const [backendSkipped, setBackendSkipped] = useState(true);
    // ------------------------------- المحادثات -------------------------------
    // ⛔ لا محادثات وهميّة (C2): المحادثات من SawaChat (السحابة). ما بقي محفوظاً من النسخة التجريبيّة يُمحى عند أوّل نشرٍ منها.
    const [conversations, setConversations] = usePersistedState("conversations", []);
    const [messagesByConversation, setMessagesByConversation] = usePersistedState("messages", {});
    const [chatsStack, setChatsStack] = useState([]); // {type: 'chat'|'group'|'new'|'newGroup'|'info', data}
    const [activeRoom, setActiveRoom] = useState(null); // null | roomCode string
    const [schedulingRoom, setSchedulingRoom] = useState(false);
    const [roomsListOpen, setRoomsListOpen] = useState(false);   // C17: جدول الغرف المجدولة
    const [scheduledRooms, setScheduledRooms] = usePersistedState("scheduledRooms", []);
    const [archivedConversations, setArchivedConversations] = usePersistedState("archivedConvs", []);
    const [pinnedConversations, setPinnedConversations] = usePersistedState("pinnedConvs", []);
    // معالجات مستقرة المرجع — تمنع إعادة رسم بطاقات القائمة بلا داعٍ
    const handleArchiveConv = useCallback((id) => {
        setArchivedConversations((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
        showToast(t("tmt_alarshfa"), "success");
    }, [showToast]);
    const handleMuteConv = useCallback((id) => {
        setMutedConversations((p) => {
            const on = p.includes(id);
            showToast(on ? t("ai_rf_alktm") : t("ai_tm_alktm"), "success");
            return on ? p.filter((x) => x !== id) : [...p, id];
        });
    }, [showToast]);
    const [showStoriesRow, setShowStoriesRow] = usePersistedState("showStoriesRow", true);
    // ── تذكير يوميّ: نصّ واحد ثابت لليوم، بدورة مبعثرة ──────────────
    // العشوائيّ المحض يكرّر قبل أن تُرى نصفُ المجموعة. الدورة تُخلط مرّة
    // ثم تُستهلك نصّاً نصّاً، فلا يعود نصّ حتى تمرّ عليها كلّها.
    // نحفظ الطول: إن تغيّر daily.json تُخلط من جديد بدل مؤشّرات فاسدة.
    const [dailyCycle, setDailyCycle] = usePersistedState("dailyTextCycle", { day: null, idx: null, queue: [], size: 0 });
    const [dailyCard, setDailyCard] = useState(null);
    useEffect(function () {
        const now = new Date();
        const key = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
        let cancelled = false;
        let timer = null;
        loadDailyReminders().then(function (pool) {
            if (cancelled || !pool || !pool.length)
                return;
            let next = dailyCycle;
            if (next.day !== key || next.size !== pool.length || typeof next.idx !== "number") {
                let queue = (next.size === pool.length && next.queue && next.queue.length) ? next.queue.slice() : null;
                if (!queue || !queue.length) {
                    queue = pool.map(function (_, i) { return i; });
                    for (let i = queue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        const tmp = queue[i]; queue[i] = queue[j]; queue[j] = tmp;
                    }
                }
                const idx = queue.shift();
                next = { day: key, idx, queue, size: pool.length };
                setDailyCycle(next);
            }
            const pick = pool[next.idx] || pool[0];
            // C74: مرّةً في اليوم — كانت تظهر عند كلّ فتح للتطبيق، وتغطّي صفحة الانضمام إلى عائلة/غرفة/مكالمة
            if (next.shownDay === key) return;
            if (/[?&](join|call|room|contact|group|code|answer)=/.test(location.search || "")) return;
            const shownNext = { ...next, shownDay: key };
            timer = setTimeout(function () { setDailyCard(pick); setDailyCycle(shownNext); }, 900);
        });
        return function () { cancelled = true; if (timer) clearTimeout(timer); };
    }, []);
    const [showFamilyReminders, setShowFamilyReminders] = usePersistedState("showFamilyReminders", true);
    const [mutedConversations, setMutedConversations] = usePersistedState("mutedConvs", []);
    const [showLinkedDevices, setShowLinkedDevices] = useState(false);
    const [showWrapped, setShowWrapped] = useState(false);
    const [showFeedback, setShowFeedback] = useState(false);
    const [chatThemes, setChatThemes] = useState({});
    const [chatDisappearing, setChatDisappearing] = useState(0);
    const myUserId = "u-1";
    // ------------------------------- المجموعات (Group Chat) -------------------------------
    const [groups, setGroups] = useState([]);   // من SawaChat: محادثات العائلات والمجموعات
    const [groupMessages, setGroupMessages] = usePersistedState("groupMessages", {});
    const [broadcastLists, setBroadcastLists] = useState([]);
    function createBroadcastList(name, recipientIds) {
        const id = `bl-${Date.now()}`;
        setBroadcastLists((prev) => [...prev, { id, name, recipientIds, sentMessages: [] }]);
        setChatsStack([{ type: "broadcast", data: { id, name, recipientIds, sentMessages: [] } }]);
    }
    function sendBroadcastMessage(listId, text) {
        const list = broadcastLists.find((b) => b.id === listId);
        if (!list)
            return;
        const sentMsg = { id: `bmsg-${Date.now()}`, text, createdAt: Date.now() };
        setBroadcastLists((prev) => prev.map((b) => (b.id === listId ? { ...b, sentMessages: [...b.sentMessages, sentMsg] } : b)));
        // نبعت الرسالة فعلياً كل واحدة لوحدها بمحادثة كل مستلم — بيانياً نفس
        // منطق "sendChatMessage" العادي، عشان كل شخص يستلمها بمحادثته الخاصة
        // بدون ما يشوف الباقين أو يعرف إنها بث جماعي (الفرق الجوهري عن مجموعة)
        list.recipientIds.forEach((conversationId) => {
            sendChatMessage(conversationId, text, null);
        });
        showToast(t("tm_albth_ila_shkhs", { length: list.recipientIds.length }), "success");
    }
    function createGroup(name, memberNames) {
        const SCg = window.SawaChat;
        if (SCg && SCg.enabled && SCg.enabled()) {
            // C3: مجموعة حقيقيّة من جهات الاتّصال (الأسماء ← المعرّفات)
            const uids = memberNames.map((n) => { const p = people.find((x) => x.name === n); return p && p.uid; }).filter(Boolean);
            SCg.createGroup(name, uids).then((cid) => { if (cid) setChatsStack([{ type: "group", data: { id: cid, name, members: [] } }]); else setChatsStack([]); });
            return;
        }
        const id = `grp-${Date.now()}`;
        const members = [
            { id: myUserId, name: "أنت", role: "admin" },
            ...memberNames.map((n, i) => ({ id: `u-new-${i}-${Date.now()}`, name: n, role: "member" })),
        ];
        setGroups((prev) => [...prev, { id, name, members }]);
        setGroupMessages((prev) => ({ ...prev, [id]: [] }));
        setChatsStack([{ type: "group", data: { id, name, members } }]);
    }
    // ── تعديل المجموعات ──
    // كل الدوال تعمل على groups فقط؛ chatsStack يحمل نسخة قديمة من المجموعة
    // ولذلك يُشتق liveGroup منها عند العرض.
    function renameGroup(groupId, newName) {
        const clean = (newName || "").trim();
        if (!clean) return;
        if (cloudChat(groupId)) { cloudChat(groupId).updateGroup(groupId, { name: clean }); return; }
        setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: clean } : g)));
    }
    function addGroupMembers(groupId, memberNames) {
        if (!memberNames || !memberNames.length) return;
        if (cloudChat(groupId)) { cloudChat(groupId).addMembers(groupId, memberNames); return; }   // على السحابة: معرّفات من منتقي جهات الاتّصال
        setGroups((prev) => prev.map((g) => {
            if (g.id !== groupId) return g;
            const existing = new Set(g.members.map((m) => m.name));
            const fresh = memberNames
                .filter((n) => !existing.has(n))
                .map((n, i) => ({ id: `u-add-${i}-${Date.now()}`, name: n, role: "member" }));
            return { ...g, members: [...g.members, ...fresh] };
        }));
    }
    function removeGroupMember(groupId, memberId) {
        if (memberId === myUserId) return;   // الخروج له مسار منفصل
        if (cloudChat(groupId)) { cloudChat(groupId).removeMember(groupId, memberId); return; }
        setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, members: g.members.filter((m) => m.id !== memberId) } : g)));
    }
    function toggleGroupAdmin(groupId, memberId) {
        if (cloudChat(groupId)) { const g = groups.find((x) => x.id === groupId); const m = g && g.members.find((x) => x.id === memberId); cloudChat(groupId).setAdmin(groupId, memberId, !(m && m.role === "admin")); return; }
        setGroups((prev) => prev.map((g) => {
            if (g.id !== groupId) return g;
            return { ...g, members: g.members.map((m) => (m.id === memberId ? { ...m, role: m.role === "admin" ? "member" : "admin" } : m)) };
        }));
    }
    function leaveGroup(groupId) {
        if (cloudChat(groupId)) { cloudChat(groupId).leaveGroup(groupId); setChatsStack([]); return; }
        setGroups((prev) => prev.filter((g) => g.id !== groupId));
        setChatsStack([]);
    }
    function sendGroupMessage(groupId, text, replyTo) {
        if (cloudChat(groupId)) { cloudChat(groupId).send(groupId, text, { reply: replyTo ? { id: replyTo.id, by: replyTo.senderId || null, text: replyTo.text } : null, mentionsFrom: true }); return; }
        const msg = { id: `gmsg-${Date.now()}`, senderId: myUserId, text, type: "text", createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function sendGroupFile(groupId, fileName, fileSize, fileUrl, type = "file", file = null) {
        if (cloudChat(groupId)) { cloudChat(groupId).sendMedia(groupId, { kind: type, blob: file, dataUrl: file ? null : fileUrl, name: fileName }); return; }
        const msg = { id: `gmsg-${Date.now()}-file`, senderId: myUserId, text: fileName, fileSize, fileUrl, type, createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function sendGroupVoice(groupId, audioUrl, duration, transcript = null, blob = null, secs = null) {
        if (cloudChat(groupId)) { cloudChat(groupId).sendMedia(groupId, { kind: "voice", blob, duration: secs || null, transcript, name: "voice" }); return; }
        const msg = { id: `gmsg-${Date.now()}-v`, senderId: myUserId, type: "voice", audioUrl, duration, createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function editGroupMessage(groupId, messageId, newText) {
        if (!newText.trim())
            return;
        if (cloudChat(groupId)) { cloudChat(groupId).edit(groupId, messageId, newText.trim()); return; }
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => (m.id === messageId ? { ...m, text: newText.trim(), edited: true } : m)),
        }));
    }
    function createGroupPoll(groupId, question, optionTexts, deadlineMinutes, anonymous) {
        if (cloudChat(groupId)) { cloudChat(groupId).sendPoll(groupId, question, optionTexts, deadlineMinutes ? Date.now() + deadlineMinutes * 60000 : null, !!anonymous); return; }
        const msg = {
            id: `gpoll-${Date.now()}`,
            type: "poll",
            question,
            options: optionTexts.map((text) => ({ text, votes: [] })),
            createdAt: Date.now(),
            creatorId: myUserId,
            deadline: deadlineMinutes ? Date.now() + deadlineMinutes * 60000 : null,
            anonymous: !!anonymous,
            editedAt: null,
        };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function editGroupPoll(groupId, pollId, question, optionTexts) {
        if (cloudChat(groupId)) { cloudChat(groupId).editPoll(groupId, pollId, question, optionTexts); showToast(t("tm_tadyl_alasttlaa"), "success"); return; }
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => {
                if (m.id !== pollId || m.type !== "poll")
                    return m;
                // نحافظ على أصوات الخيارات اللي بقيت بنفس نصها، ونصفّر خيارات جديدة
                const newOptions = optionTexts.map((text) => {
                    const existing = m.options.find((o) => o.text === text);
                    return existing ? existing : { text, votes: [] };
                });
                return { ...m, question, options: newOptions, editedAt: Date.now() };
            }),
        }));
        showToast(t("tm_tadyl_alasttlaa"), "success");
    }
    function voteGroupPoll(groupId, pollId, optionIndex) {
        if (cloudChat(groupId)) { cloudChat(groupId).vote(groupId, pollId, optionIndex); return; }
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => {
                if (m.id !== pollId || m.type !== "poll")
                    return m;
                if (m.deadline && Date.now() > m.deadline)
                    return m; // انتهت المهلة — لا تصويت جديد
                return {
                    ...m,
                    options: m.options.map((opt, i) => ({
                        ...opt,
                        votes: i === optionIndex
                            ? [...opt.votes.filter((v) => v !== myUserId), myUserId]
                            : opt.votes.filter((v) => v !== myUserId),
                    })),
                };
            }),
        }));
    }
    function createGroupBillSplit(groupId, description, totalAmount, participantAmounts, splitType) {
        if (cloudChat(groupId)) { cloudChat(groupId).sendBill(groupId, description, totalAmount, participantAmounts, splitType || "equal"); return; }
        const group = groups.find((g) => g.id === groupId);
        const participants = Object.entries(participantAmounts).map(([id, share]) => {
            var _a;
            return ({
                userId: id,
                name: ((_a = group === null || group === void 0 ? void 0 : group.members.find((m) => m.id === id)) === null || _a === void 0 ? void 0 : _a.name) || t("ai_adw"),
                share,
                paid: false,
            });
        });
        const msg = { id: `gbill-${Date.now()}`, type: "billSplit", description, totalAmount, participants, splitType: splitType || "equal", createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function payGroupBillSplit(groupId, billId) {
        if (cloudChat(groupId)) { cloudChat(groupId).billPaid(groupId, billId); showToast("✓", "success"); return; }
        const msg = (groupMessages[groupId] || []).find((m) => m.id === billId);
        const myShare = msg === null || msg === void 0 ? void 0 : msg.participants.find((p) => p.userId === myUserId);
        if (!myShare || myShare.paid)
            return;
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => m.id === billId ? { ...m, participants: m.participants.map((p) => (p.userId === myUserId ? { ...p, paid: true, paidAt: Date.now() } : p)) } : m),
        }));
        showToast(`تم تحديد حصتك (${myShare.share.toLocaleString(loc())} ج.س) كمدفوعة ✓`, "success");
    }
    function createGroupFundraiser(groupId, cause, goal, deadline) {
        if (cloudChat(groupId)) { cloudChat(groupId).sendFund(groupId, cause, goal, deadline ? new Date(`${deadline}T23:59:59`).getTime() : null); return; }
        const deadlineTimestamp = deadline ? new Date(`${deadline}T23:59:59`).getTime() : null;
        const msg = { id: `gfund-${Date.now()}`, type: "fundraiser", cause, goal, raised: 0, deadline: deadlineTimestamp, contributions: [], createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function contributeGroupFundraiser(groupId, fundraiserId) {
        setPendingContributionTarget({ groupId, fundraiserId });
    }
    function confirmContribution(amount, fromWallet) {
        const { groupId, fundraiserId } = pendingContributionTarget;
        if (!amount || amount <= 0)
            return;
        if (fromWallet) {
            if (amount > walletBalance) {
                showToast(t("alrsyd_ghyr_kaf"), "error");
                return;
            }
            setWalletBalance((b) => b - amount);
        }
        if (cloudChat(groupId)) {
            // على السحابة: يُسجَّل تعهّدك للجميع (المحفظة محاكاة — يُخصم منها محلّياً فقط إن اخترتها)
            cloudChat(groupId).contribute(groupId, fundraiserId, amount);
            setPendingContributionTarget(null);
            showToast(`سجّلت تعهّداً بـ${amount.toLocaleString(loc())} ج.س ✓`, "success");
            return;
        }
        let goalReached = false;
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => {
                if (m.id !== fundraiserId)
                    return m;
                const newRaised = m.raised + amount;
                if (newRaised >= m.goal)
                    goalReached = true;
                return { ...m, raised: newRaised, contributions: [{ name: "أنت", amount, ts: Date.now() }, ...m.contributions] };
            }),
        }));
        setPendingContributionTarget(null);
        if (goalReached) {
            showToast(`🎉 اكتمل الهدف! سجّلت تعهّداً بـ${amount.toLocaleString(loc())} ج.س ✓`, "success");
        }
        else {
            showToast(`سجّلت تعهّداً بـ${amount.toLocaleString(loc())} ج.س ✓`, "success");
        }
    }
    function createGroupTaskList(groupId, title, taskDrafts) {
        if (cloudChat(groupId)) {
            const g = groups.find((x) => x.id === groupId);
            cloudChat(groupId).sendTasks(groupId, title, taskDrafts.filter((td) => td.text && td.text.trim()).map((td, i) => {
                const m = g && g.members.find((x) => x.id === td.assigneeId);
                return { id: "t" + i, text: td.text.trim(), assigneeId: td.assigneeId, assigneeName: (m && m.name) || "", dueAt: td.dueAt ? new Date(td.dueAt).getTime() : null };
            }));
            return;
        }
        const group = groups.find((g) => g.id === groupId);
        const tasks = taskDrafts.map((td, i) => {
            var _a;
            return ({
                id: `task-${Date.now()}-${i}`,
                text: td.text.trim(),
                assigneeId: td.assigneeId,
                assigneeName: ((_a = group === null || group === void 0 ? void 0 : group.members.find((m) => m.id === td.assigneeId)) === null || _a === void 0 ? void 0 : _a.name) || t("ai_adw"),
                dueAt: td.dueAt ? new Date(td.dueAt).getTime() : null,
                status: "pending",
            });
        });
        const msg = { id: `gtask-${Date.now()}`, type: "taskList", title, tasks, createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function toggleGroupTaskStatus(groupId, listId, taskId) {
        if (cloudChat(groupId)) { const m = (groupMessages[groupId] || []).find((x) => x.id === listId); const tk = m && m.tasks && m.tasks.find((x) => x.id === taskId); cloudChat(groupId).setTask(groupId, listId, taskId, { status: tk && tk.status === "done" ? "pending" : "done" }); return; }
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => m.id === listId
                ? { ...m, tasks: m.tasks.map((tk) => (tk.id === taskId ? { ...tk, status: tk.status === "done" ? "pending" : "done" } : tk)) }
                : m),
        }));
    }
    function addGroupTaskNote(groupId, listId, taskId, note) {
        if (cloudChat(groupId)) { cloudChat(groupId).setTask(groupId, listId, taskId, { note }); return; }
        setGroupMessages((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((m) => m.id === listId
                ? { ...m, tasks: m.tasks.map((tk) => (tk.id === taskId ? { ...tk, note } : tk)) }
                : m),
        }));
    }
    function scanQrContact() {
        // C20: مسحٌ حقيقيّ (كان ينشئ محادثةً مع اسمٍ عشوائيّ وهميّ)
        if (window.SawaChat && window.SawaChat.scanAny) { window.SawaChat.scanAny(); return; }
        showToast(tl("المسح غير متاح الآن", "Scanning isn't available right now"), "error");
    }
    function createConversation(name) {
        const id = `conv-${Date.now()}`;
        setConversations((prev) => [...prev, { id, name, lastMessage: null }]);
        setMessagesByConversation((prev) => ({ ...prev, [id]: [] }));
        setChatsStack([{ type: "chat", data: { id, name } }]);
        return id;
    }
    function messageContact(contact) {
        const SC = window.SawaChat;
        if (SC && contact && contact.uid && SC.enabled && SC.enabled()) {
            const cid = SC.dmWith(contact.uid);
            SC.openDm(contact.uid);
            setChatsStack([{ type: "chat", data: { id: cid, name: contact.name, cloud: true, peerUid: contact.uid } }]);
            setTab("chats");
            return;
        }
        const existing = conversations.find((c) => c.name === contact.name);
        if (existing) {
            setChatsStack([{ type: "chat", data: existing }]);
        }
        else {
            createConversation(contact.name);
        }
        setTab("chats");
    }
    function replyToMomentPrivately(post, replyText) {
        const existing = conversations.find((c) => c.name === post.author);
        const conversationId = existing ? existing.id : createConversation(post.author);
        const momentContext = post.text ? `"${post.text.slice(0, 40)}${post.text.length > 40 ? "…" : ""}"` : t("ai_lhztk");
        sendChatMessage(conversationId, t("rda_ala", { momentContext, replyText }));
        if (existing)
            setChatsStack([{ type: "chat", data: existing }]);
        setTab("chats");
        showToast(t("tm_irsal_rdk_alkhas", { author: post.author }), "success");
    }
    const [chatDrafts, setChatDrafts] = usePersistedState("chatDrafts", {});
    function saveChatDraft(conversationId, value) {
        const realCid = String(conversationId).replace(/^g:/, "");
        if (value && value.trim() && cloudChat(realCid)) cloudChat(realCid).typing(realCid);
        setChatDrafts((prev) => {
            const next = { ...prev };
            if (value && value.trim()) next[conversationId] = value;
            else delete next[conversationId];
            return next;
        });
    }
    // فتح المحادثة يعني قراءتها — بدون هذا تبقى الشارة إلى الأبد
    function markConversationRead(conversationId) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).openChat(conversationId); return; }
        setConversations((prev) => prev.map((c) => (c.id === conversationId && c.unread > 0 ? { ...c, unread: 0 } : c)));
    }
    function markGroupRead(groupId) {
        if (cloudChat(groupId)) { cloudChat(groupId).openChat(groupId); return; }
        setGroups((prev) => prev.map((g) => (g.id === groupId && g.unread > 0 ? { ...g, unread: 0 } : g)));
    }
    // ⛔ لا محاكاة (C2): لا «وصلت/قُرئت» بمؤقّتات ولا ردود آليّة ولا «يكتب…» مزيّف.
    //    محادثة السحابة ⇒ SawaChat (إرسالٌ حقيقيّ وحالاتٌ من الخادم)؛ غير ذلك ⇒ تُحفظ محلّياً فقط.
    function cloudChat(id) { const SC = window.SawaChat; return SC && SC.isCloud && SC.isCloud(id) ? SC : null; }
    function touchFamilyContact(conversationId) {
        // تحديث آخر تواصل في صلة الرحم إذا كان الاسم يطابق شخصاً
        const conv = conversations.find(c => c.id === conversationId);
        if (!conv) return;
        setGroupPersons(prev => {
            const updated = { ...prev };
            Object.keys(updated).forEach(gId => {
                updated[gId] = updated[gId].map(p => {
                    const fn = p.local_name && p.local_name.split(" ")[0] && p.local_name.split(" ")[0].toLowerCase();
                    if (fn && conv.name && conv.name.toLowerCase().includes(fn)) return { ...p, lastContactDate: Date.now() };
                    return p;
                });
            });
            return updated;
        });
    }
    function sendChatMessage(conversationId, text, replyTo) {
        const SC = cloudChat(conversationId);
        if (SC) {
            SC.send(conversationId, text, { reply: replyTo ? { id: replyTo.id, by: replyTo.senderUserId || replyTo.senderId || null, text: replyTo.text } : null });
            touchFamilyContact(conversationId);
            return;
        }
        const msg = { id: `msg-${Date.now()}`, senderUserId: myUserId, text, createdAt: Date.now(), replyToText: (replyTo && replyTo.text) || null, status: "sent" };
        setMessagesByConversation((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] || []), msg] }));
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, lastMessage: text, lastFromMe: true, lastStatus: "sent", updatedAt: Date.now(), userTouched: true } : c)));
        touchFamilyContact(conversationId);
    }
    function editChatMessage(conversationId, messageId, newText) {
        if (!newText.trim())
            return;
        if (cloudChat(conversationId)) { cloudChat(conversationId).edit(conversationId, messageId, newText.trim()); return; }
        setMessagesByConversation((prev) => ({
            ...prev,
            [conversationId]: (prev[conversationId] || []).map((m) => (m.id === messageId ? { ...m, text: newText.trim(), edited: true } : m)),
        }));
    }
    function sendChatVoice(conversationId, audioUrl, duration, transcript = null, blob = null, secs = null) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).sendMedia(conversationId, { kind: "voice", blob, duration: secs || null, transcript, name: "voice" }); return; }
        const msg = { id: `msg-${Date.now()}-v`, senderUserId: myUserId, type: "voice", audioUrl, duration, transcript, createdAt: Date.now(), status: "sent" };
        setMessagesByConversation((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] || []), msg] }));
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, lastMessage: "🎤 رسالة صوتية" } : c)));
    }
    function forwardMessageToTargets(payload, destinationIds) {
        // C48: payload قد يكون {id, text, cid} — رسالة وسائط تُوجَّه بملفّها لا باسمها
        const src = payload && typeof payload === "object" ? payload : null;
        const text = src ? (src.text || "") : payload;
        const srcMsg = src && src.cid ? ((messagesByConversation[src.cid] || groupMessages[src.cid] || []).find((m) => m.id === src.id) || null) : null;
        const media = !!(srcMsg && ["image", "video", "file", "voice"].includes(srcMsg.type) && srcMsg.cloudMid && cloudChat(src.cid));
        const toCloud = (cid) => { if (media) window.SawaChat.forwardMessage(src.cid, src.id, cid); else cloudChat(cid).send(cid, text, { fwd: true }); };
        destinationIds.forEach((id) => {
            if (/^contact:/.test(id) && window.SawaChat && window.SawaChat.openDm) { window.SawaChat.openDm(id.slice(8)).then((cid) => { if (cid) toCloud(cid); }); return; }
            if (cloudChat(id)) { toCloud(id); return; }
            if (conversations.some((c) => c.id === id)) {
                const msg = { id: `msg-${Date.now()}-f-${id}`, senderUserId: myUserId, text, createdAt: Date.now(), forwarded: true, status: "sent" };
                setMessagesByConversation((prev) => ({ ...prev, [id]: [...(prev[id] || []), msg] }));
                setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, lastMessage: text, lastFromMe: false } : c)));
            }
            else if (groups.some((g) => g.id === id)) {
                const msg = { id: `gmsg-${Date.now()}-f-${id}`, senderId: myUserId, text, type: "text", forwarded: true, createdAt: Date.now() };
                setGroupMessages((prev) => ({ ...prev, [id]: [...(prev[id] || []), msg] }));
            }
        });
        showToast(t("tm_altwjyh_ila", { length: destinationIds.length }), "success");
    }
    function reactToChatMessage(conversationId, messageId, emoji) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).react(conversationId, messageId, emoji); return; }
        setMessagesByConversation((prev) => ({
            ...prev,
            [conversationId]: (prev[conversationId] || []).map((m) => (m.id === messageId ? { ...m, reaction: emoji } : m)),
        }));
    }
    function togglePinMessage(conversationId, messageId) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).pin(conversationId, messageId); return; }
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, pinnedMessageId: c.pinnedMessageId === messageId ? null : messageId } : c)));
    }
    function toggleStarMessage(conversationId, messageId, text) {
        var _a, _b, _c;
        const alreadyStarred = (_b = (_a = messagesByConversation[conversationId]) === null || _a === void 0 ? void 0 : _a.find((m) => m.id === messageId)) === null || _b === void 0 ? void 0 : _b.starred;
        setMessagesByConversation((prev) => ({
            ...prev,
            [conversationId]: (prev[conversationId] || []).map((m) => (m.id === messageId ? { ...m, starred: !alreadyStarred } : m)),
        }));
        if (!alreadyStarred) {
            const convName = ((_c = conversations.find((c) => c.id === conversationId)) === null || _c === void 0 ? void 0 : _c.name) || t("ai_mhadtha");
            setStarredMessages((prev) => [{ id: messageId, conversationId, conversationName: convName, text, ts: Date.now() }, ...prev]);
            showToast(t("tm_hfz_alrsala"), "success");
        }
        else {
            setStarredMessages((prev) => prev.filter((s) => s.id !== messageId));
        }
    }
    function sendGroupSticker(groupId, emoji) {
        if (cloudChat(groupId)) { cloudChat(groupId).send(groupId, emoji, { type: "sticker" }); return; }
        const msg = { id: `gmsg-${Date.now()}-s`, senderId: myUserId, text: emoji, type: "sticker", createdAt: Date.now() };
        setGroupMessages((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), msg] }));
    }
    function sendChatSticker(conversationId, emoji) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).send(conversationId, emoji, { type: "sticker" }); return; }
        const msg = { id: `msg-${Date.now()}-s`, senderUserId: myUserId, text: emoji, type: "sticker", createdAt: Date.now() };
        setMessagesByConversation((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] || []), msg] }));
    }
    function sendChatFile(conversationId, fileName, fileSize, fileUrl, type = "file", viewOnce = false, file = null) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).sendMedia(conversationId, { kind: type, blob: file, dataUrl: file ? null : fileUrl, name: fileName, viewOnce }); return; }
        const lastMessageLabel = viewOnce ? t("ai_swra_mra") : type === "image" ? t("ai_swra") : type === "video" ? t("ai_fydyw") : `📎 ${fileName}`;
        const msg = { id: `msg-${Date.now()}-file`, senderUserId: myUserId, text: fileName, fileSize, fileUrl, type, viewOnce, viewedOnce: false, createdAt: Date.now(), status: "sent" };
        setMessagesByConversation((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] || []), msg] }));
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, lastMessage: lastMessageLabel } : c)));
    }
    function markMessageViewedOnce(conversationId, messageId) {
        if (cloudChat(conversationId)) { cloudChat(conversationId).markViewedOnce(conversationId, messageId); return; }
        setMessagesByConversation((prev) => ({
            ...prev,
            [conversationId]: (prev[conversationId] || []).map((m) => (m.id === messageId ? { ...m, viewedOnce: true } : m)),
        }));
    }
    // ------------------------------- الجلسات -------------------------------
    const [sessions, setSessions] = useState([
        { id: "sess-1", device: t("ai_hdha_aljhaz"), lastActive: "الآن" },
        { id: "sess-2", device: t("ai_jhaz_akhr"), lastActive: "أمس 8:30م" },
    ]);
    function revokeSession(id) { setSessions((prev) => prev.filter((s) => s.id !== id)); }
    function revokeAllSessions() { setSessions([{ id: "sess-1", device: t("ai_hdha_aljhaz"), lastActive: "الآن" }]); }
    // ------------------------------- لحظات الأصدقاء -------------------------------
    // C47: كانت لحظتان وهميّتان («نعمات بابكر»، «خالد») تُزرعان لكلّ حسابٍ جديد فتظهر دوائر «مستخدم» فوق المحادثات — لا بيانات وهميّة
    const [momentsPosts, setMomentsPosts0] = usePersistedState("momentsPosts", []);
    const setMomentsPosts = setMomentsPosts0;
    useEffect(() => { setMomentsPosts0((prev) => (prev || []).some((p) => (p.id === "m1" || p.id === "m2") && p.authorId === null) ? prev.filter((p) => !((p.id === "m1" || p.id === "m2") && p.authorId === null)) : prev); }, []);
    function addMomentPost({ text, privacy, photoName, photoData, location, expiresAt, pollSticker }) {
        setMomentsPosts((prev) => {
            // سقف الصور المحفوظة: أقدم صورة تفقد بياناتها ويبقى نصها،
            // حتى لا تمتلئ مساحة التخزين وتتوقف بقية أجزاء التطبيق
            const MAX_PHOTOS = 12;
            let seen = 0;
            const trimmed = prev.map((p) => {
                if (!p.photoData) return p;
                seen += 1;
                return seen >= MAX_PHOTOS ? { ...p, photoData: null } : p;
            });
            return [
                { id: `m-${Date.now()}`, author: "أنت", authorId: myUserId, text, privacy, photoName, photoData, location, expiresAt, pollSticker, createdAt: Date.now(), likedByMe: false, likes: 0, views: 0, viewedBy: [], comments: [] },
                ...trimmed,
            ];
        });
    }
    function voteMomentPoll(postId, optionIndex) {
        setMomentsPosts((prev) => prev.map((p) => {
            if (p.id !== postId || !p.pollSticker)
                return p;
            return {
                ...p,
                pollSticker: {
                    ...p.pollSticker,
                    options: p.pollSticker.options.map((opt, i) => ({
                        ...opt,
                        votes: i === optionIndex
                            ? [...opt.votes.filter((v) => v !== myUserId), myUserId]
                            : opt.votes.filter((v) => v !== myUserId),
                    })),
                },
            };
        }));
    }
    function viewMomentPost(id) {
        setMomentsPosts((prev) => prev.map((p) => {
            if (p.id !== id) return p;
            const seenBy = p.viewedBy || [];
            if (seenBy.indexOf(myUserId) !== -1) return p; // شوهد سابقاً — لا يُحتسب مجدداً
            return { ...p, views: (p.views || 0) + 1, viewedBy: seenBy.concat([myUserId]) };
        }));
    }
    function deleteMomentPost(id) {
        setMomentsPosts((prev) => prev.filter((p) => p.id !== id));
    }
    function toggleMomentLike(id) {
        setMomentsPosts((prev) => prev.map((p) => (p.id === id ? { ...p, likedByMe: !p.likedByMe, likes: p.likes + (p.likedByMe ? -1 : 1) } : p)));
    }
    function addMomentComment(id, text) {
        setMomentsPosts((prev) => prev.map((p) => (p.id === id ? { ...p, comments: [...(p.comments || []), { author: "أنت", text }] } : p)));
    }
    // ------------------------------- إرسال إكسبريس -------------------------------
    const initialErsalStagesData = ersalBuildStages("pickup", "card", "أم درمان", "address");
    const shipmentTimeoutsRef = useRef({}); // { [shipmentId]: [timeoutId, ...] }
    const [shipments, setShipments] = useState([
        {
            id: "FR-10001", category: "مستندات", categoryKey: "documents", destination: "أم درمان",
            weight: 2, dimensions: { height: 20, width: 15, length: 30 }, handlingKeys: ["normal"], photoName: null,
            stageIdx: initialErsalStagesData.stages.length - 1, stages: initialErsalStagesData.stages,
            pickupEndIdx: initialErsalStagesData.pickupEndIdx, deliveryStartIdx: initialErsalStagesData.deliveryStartIdx,
            total: 4000, pickupDriver: ERSAL_PICKUP_DRIVERS[0], deliveryDriver: ERSAL_DELIVERY_DRIVERS[0], failed: false,
            proofOfDelivery: { recipientName: "خالد إبراهيم", signaturePath: "M 15 25 L 35 15 L 55 35 L 75 20 L 95 30 L 115 18 L 135 32 L 150 22", capturedAt: Date.now() - 86400000 },
        },
    ]);
    function markShipmentFailed(shipmentId, reason) {
        setShipments((prev) => prev.map((s) => (s.id === shipmentId ? { ...s, failed: true, failureReason: reason, failedAt: Date.now(), pendingChoice: null } : s)));
        showToast(t("tadhr_tslym_raja_alshhna", { shipmentId }), "error");
    }
    function changeShipmentAddress(shipmentId, newAddressText) {
        setShipments((prev) => prev.map((s) => {
            if (s.id !== shipmentId)
                return s;
            return {
                ...s,
                failed: false,
                failureReason: null,
                failedAt: null,
                pendingChoice: null,
                deliveryAddressOverride: newAddressText,
                total: s.total + ERSAL_REDELIVERY_FEE,
                stageIdx: s.deliveryStartIdx, // إعادة جدولة من نقطة التسليم — سائق تسليم جديد يُعيَّن تلقائياً
                deliveryDriver: null,
            };
        }));
        // نحاكي تعيين سائق تسليم جديد لمحاولة التسليم الثانية، بنفس منطق الإنشاء الأول
        setTimeout(() => {
            setShipments((prev) => prev.map((s) => (s.id === shipmentId && !s.deliveryDriver ? { ...s, deliveryDriver: ERSAL_DELIVERY_DRIVERS[Math.floor(Math.random() * ERSAL_DELIVERY_DRIVERS.length)] } : s)));
        }, 1200);
        showToast(`تم تحديث عنوان التسليم + ${ERSAL_REDELIVERY_FEE.toLocaleString(loc())} ج.س رسوم إعادة جدولة`, "success");
    }
    function confirmShipmentPickup(shipmentId) {
        setShipments((prev) => prev.map((s) => (s.id === shipmentId ? { ...s, pendingChoice: "pickup_confirmed" } : s)));
        showToast(t("tm_altrd_bantzark_balmrkz"), "success");
    }
    function simulateShipmentDays(shipmentId, days) {
        setShipments((prev) => prev.map((s) => (s.id === shipmentId && s.failedAt ? { ...s, failedAt: s.failedAt - days * 24 * 60 * 60 * 1000 } : s)));
    }
    function createShipment({ destination, category, categoryKey, weight, dimensions, handlingKeys, photoName, total, stagesData, insured = false, declaredValue = 0, insuranceFee = 0, deliveryWindow = null, contentDescription = "", shipmentReference = "", recipientName = "", recipientPhone = "" }) {
        const newId = `FR-${Math.floor(10000 + Math.random() * 89999)}`;
        const newShipment = {
            id: newId, category, categoryKey, destination, weight, dimensions, handlingKeys, photoName,
            stageIdx: 0, stages: stagesData.stages, pickupEndIdx: stagesData.pickupEndIdx, deliveryStartIdx: stagesData.deliveryStartIdx,
            total, pickupDriver: null, deliveryDriver: null, failed: false, cancelled: false,
            insured, declaredValue, insuranceFee, deliveryWindow, contentDescription, shipmentReference, recipientName, recipientPhone,
        };
        setShipments((prev) => [newShipment, ...prev]);
        // محاكاة تقدّم الشحنة عبر مراحلها الحقيقية — سائق الاستلام يُعيَّن أول
        // ما توصل الشحنة لمرحلة "تم الاستلام"، وسائق التسليم (شخص مختلف تمامًا)
        // يُعيَّن بمرحلة منفصلة تمامًا لاحقاً، حسب حدود pickupEndIdx/deliveryStartIdx
        const timeouts = [];
        stagesData.stages.forEach((_, i) => {
            if (i === 0)
                return;
            const tmr = setTimeout(() => {
                setShipments((prev) => prev.map((s) => {
                    if (s.id !== newId || s.cancelled)
                        return s; // أُلغيت الشحنة — ما ننفّذ أي تقدّم لاحق
                    let pickupDriver = s.pickupDriver;
                    let deliveryDriver = s.deliveryDriver;
                    if (i === 1 && !pickupDriver)
                        pickupDriver = ERSAL_PICKUP_DRIVERS[Math.floor(Math.random() * ERSAL_PICKUP_DRIVERS.length)];
                    if (i === stagesData.deliveryStartIdx && !deliveryDriver)
                        deliveryDriver = ERSAL_DELIVERY_DRIVERS[Math.floor(Math.random() * ERSAL_DELIVERY_DRIVERS.length)];
                    const isFinalStage = i === stagesData.stages.length - 1;
                    const proofOfDelivery = isFinalStage
                        ? {
                            recipientName: ERSAL_RECIPIENT_NAME_POOL[Math.floor(Math.random() * ERSAL_RECIPIENT_NAME_POOL.length)],
                            signaturePath: generateSignaturePath(),
                            capturedAt: Date.now(),
                        }
                        : s.proofOfDelivery;
                    return { ...s, stageIdx: i, pickupDriver, deliveryDriver, proofOfDelivery };
                }));
                // تنبيه فوري حقيقي عند كل تغيير حالة — يصل لمركز التنبيهات مباشرة،
                // نفس آلية بقية تنبيهات التطبيق، بلا تأخير أو محاكاة إضافية
                const stageLabel = stagesData.stages[i];
                setNotifications((prevN) => [
                    { id: `n-shipment-${newId}-${i}`, type: "shipment", title: t("thdyth_shhna"), body: t("shhntk_almrhla", { id: newId, stage: stageLabel }), read: false },
                    ...prevN,
                ]);
            }, i * 1200);
            timeouts.push(tmr);
        });
        shipmentTimeoutsRef.current[newId] = timeouts;
        return newId;
    }
    function cancelShipment(shipmentId) {
        (shipmentTimeoutsRef.current[shipmentId] || []).forEach((tmr) => clearTimeout(tmr));
        delete shipmentTimeoutsRef.current[shipmentId];
        setShipments((prev) => prev.map((s) => (s.id === shipmentId ? { ...s, cancelled: true } : s)));
        showToast(t("tm_ilgha_alshhna"), "success");
    }
    function reorderShipment(oldShipment) {
        const cityMatch = ERSAL_CITIES.find((c) => c.name === oldShipment.destination) || ERSAL_CITIES[0];
        const stagesData = ersalBuildStages("pickup", "card", cityMatch.name, "address");
        const newId = createShipment({
            destination: oldShipment.destination,
            category: oldShipment.category,
            categoryKey: oldShipment.categoryKey,
            weight: oldShipment.weight,
            dimensions: oldShipment.dimensions,
            handlingKeys: oldShipment.handlingKeys,
            photoName: oldShipment.photoName,
            total: oldShipment.total,
            stagesData,
            contentDescription: oldShipment.contentDescription,
            shipmentReference: oldShipment.shipmentReference,
            declaredValue: oldShipment.declaredValue,
            insured: oldShipment.insured,
            insuranceFee: oldShipment.insuranceFee,
            deliveryWindow: oldShipment.deliveryWindow,
        });
        showToast(t("tm_insha_shhna_jdyda", { newId }), "success");
    }
    function rateCourier(shipmentId, rating) {
        setShipments((prev) => prev.map((s) => (s.id === shipmentId ? { ...s, courierRating: rating } : s)));
        showToast(t("shkra_ala_tqyymk"), "success");
    }
    function bulkCreateShipments(rows) {
        rows.forEach((row, i) => {
            const cityMatch = ERSAL_CITIES.find((c) => { var _a; return (_a = row.destination) === null || _a === void 0 ? void 0 : _a.includes(c.name); }) || ERSAL_CITIES[0];
            const typeMatch = ERSAL_SHIPMENT_TYPES.find((t) => t.key === row.shipmentType || t.label === row.shipmentType) || ERSAL_SHIPMENT_TYPES[0];
            const weight = Number(row.weight) || 1;
            const total = ERSAL_BASE_PRICE + weight * ERSAL_WEIGHT_FEE_PER_KG + cityMatch.fee + typeMatch.surcharge;
            const stagesData = ersalBuildStages("pickup", "card", cityMatch.name, "address");
            setTimeout(() => {
                createShipment({
                    destination: cityMatch.name, category: typeMatch.label, categoryKey: typeMatch.key,
                    weight, dimensions: { height: 0, width: 0, length: 0 }, handlingKeys: ["normal"], photoName: null,
                    total, stagesData,
                });
            }, i * 300); // فاصل بسيط بين كل شحنة عشان معرّفات FR-xxxxx ما تتصادم
        });
        showToast(t("tm_insha_shhna_mn", { length: rows.length }), "success");
    }
    // ------------------------------- تاكسي سوا -------------------------------
    const [taxiRide, setTaxiRide] = useState(null);
    const [taxiTripsHistory, setTaxiTripsHistory] = useState([]);
    const [scheduledTaxiRides, setScheduledTaxiRides] = useState([]);
    const taxiTimeoutsRef = useRef([]);
    function requestTaxiRide(vehicleKey, destination, fare, paymentMethod = "cash", womenOnly = false) {
        const tripId = `trip-${Date.now()}`;
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        setTaxiRide({ id: tripId, stageIdx: 0, driver: null, destination, fare, vehicleKey, paymentMethod, womenOnly, pin, scheduled: false });
        const fullPool = TAXI_DRIVERS[vehicleKey] || TAXI_DRIVERS.economy;
        const filteredPool = womenOnly ? fullPool.filter((d) => d.gender === "female") : fullPool;
        const pool = filteredPool.length > 0 ? filteredPool : fullPool;
        const matchedPreference = !womenOnly || filteredPool.length > 0;
        const driver = pool[Math.floor(Math.random() * pool.length)];
        const t1 = setTimeout(() => {
            setTaxiRide((prev) => (prev && prev.id === tripId ? { ...prev, stageIdx: 1, driver } : prev));
            if (womenOnly && !matchedPreference)
                showToast(t("ma_fyh_sayqa_mtaha"), "error");
        }, 1500);
        const t2 = setTimeout(() => setTaxiRide((prev) => (prev && prev.id === tripId ? { ...prev, stageIdx: 2 } : prev)), 3000);
        const t3 = setTimeout(() => {
            setTaxiRide((prev) => {
                if (!prev || prev.id !== tripId)
                    return prev; // أُلغيت الرحلة قبل الاكتمال — ما ننفّذ شي
                const finished = { ...prev, stageIdx: 3 };
                setTaxiTripsHistory((hist) => [{ id: tripId, destination, fare, vehicleKey, driver: finished.driver, paymentMethod, completedAt: Date.now() }, ...hist]);
                if (paymentMethod === "wallet") {
                    setWalletBalance((b) => b - fare);
                    setWalletTransactions((prevT) => [{ id: `w-${Date.now()}`, type: "debit", amount: fare, note: t("rhla_taksy", { destination }), ts: Date.now() }, ...prevT]);
                }
                return finished;
            });
        }, 4500);
        taxiTimeoutsRef.current = [t1, t2, t3];
    }
    function cancelTaxiRide() {
        taxiTimeoutsRef.current.forEach((tmr) => clearTimeout(tmr));
        taxiTimeoutsRef.current = [];
        setTaxiRide(null);
        showToast(t("tm_ilgha_alrhla"), "success");
    }
    function scheduleRide(vehicleKey, destination, fare, paymentMethod, dateTimeStr, womenOnly = false) {
        const id = `sched-${Date.now()}`;
        setScheduledTaxiRides((prev) => [...prev, { id, vehicleKey, destination, fare, paymentMethod, womenOnly, scheduledFor: new Date(dateTimeStr).getTime() }]);
        showToast(t("tmt_jdwla_rhltk_ila", { destination }), "success");
    }
    function cancelScheduledRide(id) {
        setScheduledTaxiRides((prev) => prev.filter((r) => r.id !== id));
        showToast(t("tm_ilgha_alrhla_almjdwla"), "success");
    }
    function triggerScheduledRide(id) {
        const sched = scheduledTaxiRides.find((r) => r.id === id);
        if (!sched)
            return;
        setScheduledTaxiRides((prev) => prev.filter((r) => r.id !== id));
        requestTaxiRide(sched.vehicleKey, sched.destination, sched.fare, sched.paymentMethod, sched.womenOnly);
    }
    function rateDriverTrip(tripId, rating, comment) {
        setTaxiTripsHistory((hist) => hist.map((trip) => (trip.id === tripId ? { ...trip, rating, comment: comment || null } : trip)));
        showToast(t("shkra_ala_tqyymk"), "success");
    }
    // ------------------------------- المحفظة -------------------------------
    const [walletUnlocked, setWalletUnlocked] = useState(false);
    const [walletPin, setWalletPin] = useState(null); // منفصل تماماً عن PIN قفل التطبيق
    const [linkedPaymentMethods, setLinkedPaymentMethods] = useState([]);
    const [blockedConversations, setBlockedConversations] = usePersistedState("blockedConvs", []);
    const [lockedConversationIds, setLockedConversationIds] = usePersistedState("lockedConvs", []);
    const [pendingContributionTarget, setPendingContributionTarget] = useState(null);
    const [starredMessages, setStarredMessages] = useState([]);
    const [typingConversations, setTypingConversations] = useState([]);
    const [callLog, setCallLog] = usePersistedState("callLog", initialCallLog);
    // C27: شارة «فائتة» على تبويب المكالمات تُحسب منذ آخر فتحٍ للتبويب (كانت تبقى ما دام في السجلّ مكالمةٌ فائتة)
    const [missedSeenAt, setMissedSeenAt] = usePersistedState("missedSeenAt", 0, 50);
    const missedNew = callLog.filter((c) => c.type === "missed" && (c.timestamp || 0) > (missedSeenAt || 0)).length;
    useEffect(() => { if (tab === "calls") setMissedSeenAt(Date.now()); }, [tab, callLog.length]);
    const [favoriteContacts, setFavoriteContacts] = useState([]);
    const [callSettings, setCallSettings] = useState({ requireApproval: false, defaultScheduleType: "audio" });
    const [speedDialContacts, setSpeedDialContacts] = useState([]);
    const [scheduledCalls, setScheduledCalls] = useState([]);
    const scheduledCallTimersRef = useRef({});
    function addScheduledCall(entry) {
        // C7: موعدٌ حقيقيّ في الخادم (يظهر عند المدعوّين ويصلهم تذكير) — والقائمة يعيد نشرها SawaRTC
        const R = window.SawaRTC;
        if (R && R.enabled && R.enabled() && (entry.peerUid || entry.cid)) {
            R.schedSave(entry).catch(() => showToast("تعذّر حفظ الموعد — تحقّق من الاتّصال", "error"));
            showToast(t("tm_hfz_mwad_almkalma", { contactName: entry.contactName }), "success");
            return;
        }
        setScheduledCalls((prev) => [...prev, entry]);
        // تذكير حقيقي — نحسب الوقت الفعلي المتبقّي حتى موعد التذكير، ونجدوله
        // بمؤقّت حقيقي لو كان بمدى زمني معقول ضمن هذي الجلسة
        const reminderTime = entry.timestamp - entry.reminderMinutes * 60000;
        const msUntilReminder = reminderTime - Date.now();
        if (msUntilReminder > 0 && msUntilReminder < 24 * 60 * 60 * 1000) {
            const timer = setTimeout(() => sendCallReminder(entry), msUntilReminder);
            scheduledCallTimersRef.current[entry.id] = timer;
        }
        showToast(t("tm_hfz_mwad_almkalma", { contactName: entry.contactName }), "success");
    }
    function sendCallReminder(entry) {
        const newNotif = {
            id: `n-callreminder-${entry.id}`,
            type: "schedule",
            title: t("ai_tdhkyr_mkalma"),
            body: `مكالمة ${entry.callType === "video" ? t("ai_fydyw_2") : t("ai_swtya")} مع ${entry.contactName} الساعة ${entry.startTime}`,
            read: false,
        };
        setNotifications((prev) => [newNotif, ...prev]);
    }
    function deleteScheduledCall(id) {
        const cloudEntry = scheduledCalls.find((s) => s.id === id && s.cloud);
        if (cloudEntry && window.SawaRTC) { window.SawaRTC.schedRemove(id); showToast(t("tm_ilgha_almwad"), "success"); return; }
        if (scheduledCallTimersRef.current[id]) {
            clearTimeout(scheduledCallTimersRef.current[id]);
            delete scheduledCallTimersRef.current[id];
        }
        setScheduledCalls((prev) => prev.filter((s) => s.id !== id));
        showToast(t("tm_ilgha_almwad"), "success");
    }
    function clearCallLog() {
        setCallLog([]);
        showToast(t("tm_msh_sjl_almkalmat"), "success");
    }
    // C7: تذكيرٌ داخل التطبيق أيضاً للمواعيد الحقيقيّة (لي ولمن دعاني) — والإشعار يأتي من الخادم حتّى والتطبيق مغلق
    useEffect(() => {
        scheduledCalls.forEach((e) => {
            if (!e.cloud || scheduledCallTimersRef.current[e.id]) return;
            const ms = e.timestamp - e.reminderMinutes * 60000 - Date.now();
            if (ms > 0 && ms < 24 * 60 * 60 * 1000) scheduledCallTimersRef.current[e.id] = setTimeout(() => sendCallReminder(e), ms);
        });
    }, [scheduledCalls]);
    // ⛔ لا حضور عشوائيّ (C1): «متّصل الآن» حقيقيّ من SawaChat (Realtime Database)، وجهات الاتّصال كذلك
    const [onlineContacts, setOnlineContacts] = useState([]);
    const [people, setPeople] = useState(() => (window.SawaChat ? window.SawaChat.contacts() : []));
    const [myProfile, setMyProfile] = useState(() => (window.SawaChat && window.SawaChat.profile && window.SawaChat.me() ? window.SawaChat.profile() : null));
    setLiveContacts(people);
    useEffect(() => { if (window.SawaChat && window.SawaChat.bindApp) window.SawaChat.bindApp({ setPeople, setOnlineContacts, setMyProfile,
        // C2: المحادثات الحقيقيّة تُنشر في نفس حالات الواجهة
        setConversations, setMessagesByConversation, setGroups, setGroupMessages, setTypingConversations,
        setArchivedConversations, setPinnedConversations, setMutedConversations, setLockedConversationIds, setChatFolders,
        setFolderAssignments, setChatThemes, setConversationTones, setStarredMessages, setBlockedConversations, setBroadcastLists,
        openChatById: (cid) => openChatByIdRef.current && openChatByIdRef.current(cid),
        goTab: (k) => { setStack([]); setTab(k); } }); }, []);
    // C5: الضغط على إشعار يفتح المحادثة نفسها (مرجعٌ حيّ لأحدث القوائم)
    const openChatByIdRef = useRef(null);
    openChatByIdRef.current = (cid) => {
        setStack([]); setTab("chats");
        const isGroup = /^(fam_|grp_)/.test(cid);
        const found = isGroup ? groups.find((g) => g.id === cid) : conversations.find((c) => c.id === cid);
        setChatsStack([{ type: isGroup ? "group" : "chat", data: found || (isGroup ? { id: cid, name: "", members: [] } : { id: cid, name: "", cloud: true }) }]);
    };
    // C9: مفتاح الإشعارات يعكس الحالة الفعليّة (يُحدَّث عند التفعيل/الإيقاف/تغيير الإذن من إعدادات الهاتف)
    useEffect(() => {
        const sync = () => { const SCp = window.SawaChat; setBrowserNotifEnabled(!!(SCp && SCp.pushEnabled && SCp.pushEnabled())); };
        sync();
        window.addEventListener("sawa-push-state", sync);
        return () => window.removeEventListener("sawa-push-state", sync);
    }, []);
    // إعداداتي في المحادثات تتزامن بين أجهزتي (SawaChat يتجاهلها قبل تحميل نسخة الخادم)
    useEffect(() => { if (window.SawaChat && window.SawaChat.observePrefs) window.SawaChat.observePrefs({ archived: archivedConversations, pinned: pinnedConversations,
        muted: mutedConversations, locked: lockedConversationIds, folders: chatFolders, folderOf: folderAssignments, themes: chatThemes,
        tones: conversationTones, starred: starredMessages, blocked: blockedConversations, broadcasts: broadcastLists }); },
        [archivedConversations, pinnedConversations, mutedConversations, lockedConversationIds, chatFolders, folderAssignments, chatThemes, conversationTones, starredMessages, blockedConversations, broadcastLists]);
    // المحادثة المفتوحة: تُعلَّم مقروءة وتُستمع رسائلها؛ الخروج منها يوقف «قُرئت» التلقائيّة
    useEffect(() => {
        const SC = window.SawaChat; if (!SC || !SC.openChat) return;
        const top = chatsStack[chatsStack.length - 1];
        const cid = tab === "chats" && top && (top.type === "chat" || top.type === "group" || top.type === "info") && top.data ? top.data.id : null;
        if (cid && SC.isCloud(cid)) SC.openChat(cid); else SC.closeChat(null);
    }, [tab, chatsStack]);
    // C6: المكالمات الحقيقيّة تُسجَّل هنا · وتُحذف أمثلة السجلّ القديمة (c1..c3) ممّن حُفظت عندهم
    useEffect(() => {
        setCallLog((prev) => (prev || []).filter((x) => !/^c[123]$/.test(x.id)));
        if (window.SawaRTC && window.SawaRTC.bindApp) window.SawaRTC.bindApp({ setCallLog, setScheduledCalls, setScheduledRooms });
    }, []);
    function logCall(name, callType, duration, wasConnected, participants) {
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const durationLabel = wasConnected ? `${mins}:${String(secs).padStart(2, "0")}` : null;
        const entry = {
            id: `call-${Date.now()}`,
            name,
            callType, // audio | video
            type: wasConnected ? "outgoing" : "missed",
            time: "الآن",
            duration: durationLabel,
            timestamp: Date.now(),
            // من انضم للمكالمة بعد بدايتها — يظهر في السجل كمكالمة جماعية
            participants: (participants && participants.length) ? participants.slice() : null,
        };
        setCallLog((prev) => [entry, ...prev]);
    }
    function toggleFavoriteContact(name) {
        setFavoriteContacts((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
    }
    function toggleChatLock(conversationId) {
        setLockedConversationIds((prev) => prev.includes(conversationId) ? prev.filter((id) => id !== conversationId) : [...prev, conversationId]);
    }
    function blockContact(conversationId) {
        setBlockedConversations((prev) => [...prev, conversationId]);
        showToast(t("tm_hzr_jha_alatsal"), "success");
    }
    function unblockContact(conversationId) {
        setBlockedConversations((prev) => prev.filter((id) => id !== conversationId));
        showToast(t("tm_ilgha_alhzr"), "success");
    }
    const [spendingLimit, setSpendingLimit] = useState(null);
    const [walletPasskeyId, setWalletPasskeyId] = useState(null);
    const [walletBalance, setWalletBalance] = useState(45200);
    const walletCardNumber = "4532123456781234";
    const [kycStatus, setKycStatus] = useState("none"); // none | pending | verified
    const [kycDismissed, setKycDismissed] = usePersistedState("kycDismissed", false);
    // ─── الجمعية الإلكترونية ───
    const CURRENT_USER_ID = "me";
    const [jamiyaList, setJamiyaList] = useState([
        {
            id: "j1",
            name: "جمعية العائلة الكبيرة",
            amountPerMember: 5000,
            members: [
                { id: "me", name: "أنت" },
                { id: "m2", name: "أم محمد" },
                { id: "m3", name: "أخ كريم" },
                { id: "m4", name: "عمة فاطمة" },
                { id: "m5", name: "ابن عم علي" },
                { id: "m6", name: "خالة نور" },
            ],
            rounds: [
                { memberId: "m3", paid: true, payments: { me: true, m2: true, m3: true, m4: true, m5: true, m6: true } },
                { memberId: "m2", paid: true, payments: { me: true, m2: true, m3: true, m4: true, m5: true, m6: true } },
                { memberId: "me", paid: false, payments: { me: false, m2: true, m3: true, m4: false, m5: false, m6: false } },
                { memberId: "m4", paid: false, payments: {} },
                { memberId: "m5", paid: false, payments: {} },
                { memberId: "m6", paid: false, payments: {} },
            ],
        },
    ]);
    function payJamiya(jamiyaId, amount) {
        if (amount > walletBalance) {
            showToast("الرصيد غير كافٍ", "error");
            return;
        }
        setWalletBalance((b) => b - amount);
        setWalletTransactions((prev) => [
            { id: `w-${Date.now()}`, type: "debit", amount, note: "دفع حصة الجمعية", ts: Date.now() },
            ...prev,
        ]);
        setJamiyaList((prev) => prev.map((j) => {
            if (j.id !== jamiyaId)
                return j;
            const currentRound = j.rounds.findIndex((r) => !r.paid);
            if (currentRound < 0)
                return j;
            const newRounds = j.rounds.map((r, idx) => {
                if (idx !== currentRound)
                    return r;
                const newPayments = { ...r.payments, [CURRENT_USER_ID]: true };
                const allPaid = j.members.every((m) => newPayments[m.id]);
                return { ...r, payments: newPayments, paid: allPaid };
            });
            return { ...j, rounds: newRounds };
        }));
        showToast("تم دفع حصتك ✓", "success");
    }
    function createJamiya({ name, amountPerMember, memberCount }) {
        const newId = `j-${Date.now()}`;
        const rounds = Array.from({ length: memberCount }, (_, i) => ({
            memberId: i === 0 ? CURRENT_USER_ID : `nm-${newId}-${i}`,
            paid: false,
            payments: {},
        }));
        const members = [
            { id: CURRENT_USER_ID, name: "أنت" },
            ...Array.from({ length: memberCount - 1 }, (_, i) => ({ id: `nm-${newId}-${i + 1}`, name: `عضو ${i + 2}` })),
        ];
        setJamiyaList((prev) => [...prev, { id: newId, name, amountPerMember, members, rounds }]);
        showToast(`تم إنشاء "${name}" ✓`, "success");
    }
    function handleLogout() {
        // C20: خروجٌ حقيقيّ (Firebase + الإشعارات + البيانات المحلّيّة) بنافذة تأكيد — كان يقفل الشاشة برمزٍ لم يُضبط
        if (window.SawaChat && window.SawaChat.signOutSheet && window.SawaChat.signOutSheet()) return;
        if (window.confirm(t("tsjyl_alkhrwj_sthtaj_ila"))) {
            setStack([]);
            setTab("me");
            setFlow("locked");
        }
    }
    function deleteEncryptionKeys() {
        // إصلاح: الرسالة تدّعي مسح "كل البيانات المحلية" — قبل كانت تمسح رمز
        // القفل والملاحظات بس، تاركة صلة الرحم والمحفظة وسجل النشاط كما هي.
        // الآن تمسح فعلياً كل حالة محلية لتطابق الادّعاء بصدق
        setPin(null);
        setNotes([]);
        setGroupPersons({});
        setKinshipRelations([]);
        setFamilyFavorites({});
        setFamilyGroups([]);
        setCurrentGroupId("");
        setMembers([]);
        setGroupSettings({});
        setSchedules([]);
        setEvents([]);
        setActivityLog([]);
        setDismissedSuggestions({});
        setWalletBalance(0);
        setWalletTransactions([]);
        setLinkedPaymentMethods([]);
        setRedeemedReferralCode(null);
        setStack([]);
        setFlow("setup");
        showToast(t("tm_hdhf_mfatyh_altshfyr"), "success");
    }
    function addPaymentMethod(data) {
        setLinkedPaymentMethods((prev) => [...prev, { id: `pm-${Date.now()}`, ...data }]);
        showToast(data.type === "card" ? t("ai_rbt_btaqa") : t("ai_rbt_hsab"), "success");
    }
    function submitKyc() {
        setKycStatus("pending");
        // محاكاة مراجعة — يفترض بالإنتاج الحقيقي مراجعة يدوية أو تلقائية من مزوّد خارجي
        setTimeout(() => setKycStatus("verified"), 4000);
    }
    const [walletTransactions, setWalletTransactions] = useState([
        { id: "w1", type: "debit", amount: 3000, note: "دفع من المحفظة — إرسال إكسبريس", ts: Date.now() - 3600000 },
        { id: "w2", type: "credit", amount: 20000, note: "تغذية المحفظة — بطاقة بنكك", ts: Date.now() - 7200000 },
    ]);
    function topUpWallet(bankName, amount) {
        const amt = Number(amount) || 10000;
        setWalletBalance((prev) => prev + amt);
        setWalletTransactions((prev) => [{ id: `w-${Date.now()}`, type: "credit", amount: amt, note: `تغذية المحفظة — ${bankName}`, ts: Date.now() }, ...prev]);
        showToast(`تم إضافة ${amt.toLocaleString(loc())} ج.س ✓`, "success");
    }
    function transferWallet(toName, amount) {
        if (!amount || amount <= 0 || amount > walletBalance)
            return;
        setWalletBalance((prev) => prev - amount);
        setWalletTransactions((prev) => [{ id: `w-${Date.now()}`, type: "debit", amount, note: t("thwyl_mrsl_ila", { toName }), ts: Date.now() }, ...prev]);
        showToast(`تم الإرسال ✓ — ${amount.toLocaleString(loc())} ج.س إلى ${toName}`, "success");
    }
    function scanPay(merchantName, amount) {
        setWalletBalance((prev) => prev - amount);
        setWalletTransactions((prev) => [{ id: `w-${Date.now()}`, type: "debit", amount, note: t("dfa_bmsh_qr", { merchantName }), ts: Date.now() }, ...prev]);
        showToast(`تم الدفع ✓ — ${amount.toLocaleString(loc())} ج.س لـ${merchantName}`, "success");
    }
    function removePaymentMethod(methodId) {
        setLinkedPaymentMethods((prev) => prev.filter((m) => m.id !== methodId));
        showToast(t("tm_ilgha_rbt_wsyla"), "success");
    }
    // ------------------------------- تصدير/استيراد البيانات (JSON حقيقي) -------------------------------
    function exportUserData() {
        // التصدير يقتصر على الشحنات ورحلات التاكسي. المحفظة مؤجَّلة لمرحلة
        // لاحقة (غير مُفعَّلة بهذا الإصدار). رسائل الدردشة عمداً غير مشمولة —
        // تُدار عبر ميزة "نسخ احتياطي" منفصلة واختيارية لمفاتيح التشفير فقط.
        const payload = {
            exportedAt: new Date().toISOString(),
            version: 1,
            shipments,
            taxiTripsHistory,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sawa-export-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(t("tm_tnzyl_mlf_byanatk"), "success");
    }
    function importUserData(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            var _a, _b;
            try {
                const data = JSON.parse(e.target.result);
                if (Array.isArray(data.shipments))
                    setShipments(data.shipments);
                if (Array.isArray(data.taxiTripsHistory))
                    setTaxiTripsHistory(data.taxiTripsHistory);
                showToast(`تم الاستيراد بنجاح — ${((_a = data.shipments) === null || _a === void 0 ? void 0 : _a.length) || 0} شحنة، ${((_b = data.taxiTripsHistory) === null || _b === void 0 ? void 0 : _b.length) || 0} رحلة تاكسي`, "success");
            }
            catch (_c) {
                showToast(t("almlf_ghyr_salh_yjb"), "error");
            }
        };
        reader.readAsText(file);
    }
    function toggleFamilyFav(personId) {
        setFamilyFavorites((prev) => ({ ...prev, [personId]: !prev[personId] }));
    }
    // يُطبَّق بعد إضافة/تعديل شخص عنده ربط بمجموعة ثانية — يحدّث الطرف الآخر
    // ليؤشّر رجوعاً لنفس الشخص (ربط ثنائي الاتجاه)، ويزامن الهاتف والميلاد بس
    // (الخيار الثالث المتّفق عليه: خفيف، بدون سجل شخص موحّد كامل)
    function applyCrossGroupLink(currentGroupId, currentPersonId, linkedTo, phone, birthday) {
        if (!(linkedTo === null || linkedTo === void 0 ? void 0 : linkedTo.groupId) || !(linkedTo === null || linkedTo === void 0 ? void 0 : linkedTo.personId))
            return;
        setGroupPersons((prev) => ({
            ...prev,
            [linkedTo.groupId]: (prev[linkedTo.groupId] || []).map((p) => p.id === linkedTo.personId
                ? { ...p, linkedTo: { groupId: currentGroupId, personId: currentPersonId }, contacts: phone ? { phone } : p.contacts, birthday: birthday || p.birthday }
                : p),
        }));
    }
    // إضافة سريعة بالنسب المتسلسل — الاسم الأول ثم الوالد ثم الجد فصاعداً،
    // كل اسم يُنشأ كشخص جديد دائماً (بدون ربط تلقائي بأي تطابق اسم موجود
    // مسبقاً — أضمن، والمستخدم يقدر يربط يدوياً بعدين لو فعلاً نفس الشخص)
    function addPersonChain(groupId, chainNames, rel = {}, targetIndex = 0, matchDecisions = {}, firstGender = "male", firstIsSelf = true, childMother = {}) {
        var _a;
        const { brothers = [], sisters = [], sons = [], daughters = [], wives = [] } = rel;
        // ⛔ ما يعود من هنا مُعرِّفات قرابة تُخزَّن في p.kinship وتُطابَق في خرائط
        // KINSHIP_* ثم تُعرض عبر kinshipLabel(). لا تُترجَم في مكانها أبداً.
        const kinshipForIndex = (i) => {
            if (i === 0)
                return "أخرى";
            if (i === 1)
                return "الوالد";
            if (i === 2)
                return "الجد";
            return `سلف (${i + 1})`; // ⛔ مُعرِّف عربي ثابت — kinshipLabel() تترجمه وقت العرض
        };
        const existing = groupPersons[groupId] || [];
        // إن قرّر المستخدم أن اسماً مكرّراً "هو نفسه"، نُعيد استخدام سجله الموجود
        // بدل إنشاء نسخة — فتتصل السلسلة بشجرته القائمة بدل شجرة موازية.
        const reusedId = (name) => {
            var _a;
            // C74: القرار مُفهرَس بالاسم المُطبَّع (normalizeArabicName) — كانت المطابقة هنا بلا تطبيع فـ«أحمد»
            //      لا تجد «احمد» فيُنشأ والدٌ ثانٍ رغم اختيار «هو نفسه»
            const low = normalizeArabicName(name);
            if (matchDecisions[low] !== "same" && matchDecisions[name.trim().toLowerCase()] !== "same")
                return null;
            return ((_a = existing.find((p) => normalizeArabicName(p.local_name) === low)) === null || _a === void 0 ? void 0 : _a.id) || null;
        };
        const newId = () => `gp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const chainIds = chainNames.map((name) => reusedId(name) || newId());
        const newPersons = chainNames
            .map((name, i) => (reusedId(name) ? null : {
            id: chainIds[i], local_name: name,
            // الأول قد يكون أنثى؛ ما بعده آباء وأجداد فذكور قطعاً
            kinship: i === 0 ? (firstIsSelf ? "نفسي" : (firstGender === "female" ? "البنت" : "الابن")) : kinshipForIndex(i),
            gender: i === 0 ? firstGender : "male",
            proximity: proximityForKinship(i === 0 ? (firstIsSelf ? "نفسي" : (firstGender === "female" ? "البنت" : "الابن")) : kinshipForIndex(i)),
            alive: true, favorite: false, locations: [],
            lastContactDate: null, addedAt: Date.now(), contacts: null, notes: "", linkedTo: null,
        }))
            .filter(Boolean);
        const targetId = (_a = chainIds[targetIndex]) !== null && _a !== void 0 ? _a : chainIds[0];
        const newRelations = [];
        for (let i = 0; i < chainIds.length - 1; i++) {
            // names[i+1] هو الوالد لـ names[i] — سلسلة أب/ابن متصلة
            newRelations.push({ id: `k-${Date.now()}-${i}`, groupId, source: chainIds[i + 1], target: chainIds[i], type: "parent" });
        }
        // الإخوة والأبناء والزوجات الثلاثة يتبعون نفس الجيل المُختار بمحدّد
        // "لِمَن؟" — مو الاسم الأول دائماً كما كان سابقاً
        // مجموعات الأقارب — كل مجموعة بجنسها وصلتها ونوع علاقتها بالهدف
        // صلة الهدف (الجيل المختار في "لِمَن؟") تحدّد صلة أقاربه نسبةً لصاحب الشجرة
        const targetKinship = targetIndex === 0
            ? (firstIsSelf ? "نفسي" : (firstGender === "female" ? "البنت" : "الابن"))
            : kinshipForIndex(targetIndex);
        // جنس الهدف: الاسم الأول قد يكون أنثى، وما بعده آباء وأجداد فذكور
        const targetGender = targetIndex === 0 ? firstGender : "male";
        // الزوج مخالف لجنس الهدف دائماً — لا يُثبَّت أنثى
        const spouseGender = targetGender === "female" ? "male" : "female";
        const RELATIVE_GROUPS = [
            { names: brothers, gender: "male", edge: "sibling", tag: "bro" },
            { names: sisters, gender: "female", edge: "sibling", tag: "sis" },
            { names: sons, gender: "male", edge: "child", tag: "son" },
            { names: daughters, gender: "female", edge: "child", tag: "dau" },
            { names: wives, gender: spouseGender, edge: "spouse", tag: "wife" },
        ].map((g) => ({ ...g, kinship: deriveKinship(targetKinship, g.edge, g.gender) }));
        const extraPersons = [];
        // نُولّد مُعرِّفات كل المجموعات أولاً: ربط الابن بأمّه يحتاج مُعرِّف
        // الزوجة، والزوجات تأتي بعد الأبناء في ترتيب المجموعات.
        const idsByTag = {};
        RELATIVE_GROUPS.forEach((g) => { idsByTag[g.tag] = g.names.map((name) => reusedId(name) || newId()); });
        const wifeGroup = RELATIVE_GROUPS.find((g) => g.tag === "wife");
        const wifeIdByName = {};
        if (wifeGroup)
            wifeGroup.names.forEach((n, i) => { wifeIdByName[n.trim()] = idsByTag.wife[i]; });
        RELATIVE_GROUPS.forEach((g) => {
            const ids = idsByTag[g.tag];
            g.names.forEach((name, i) => {
                if (!reusedId(name)) {
                    extraPersons.push({
                        id: ids[i], local_name: name, kinship: g.kinship, gender: g.gender, // ⛔ تخزين مُعرِّف
                        proximity: proximityForKinship(g.kinship), alive: true, favorite: false,
                        locations: [], lastContactDate: null, addedAt: Date.now(), contacts: null, notes: "", linkedTo: null,
                    });
                }
                newRelations.push({
                    id: `k-${Date.now()}-${g.tag}-${ids[i]}`,
                    groupId,
                    source: targetId,
                    target: ids[i],
                    type: g.edge === "child" ? "parent" : g.edge,
                });
                // تعدّد الزوجات: الأب وحده لا يميّز أبناء أيّ زوجة، فنربط
                // الابن بأمّه أيضاً متى حدّدها المستخدم. حافة ثانية لا بديلة.
                if (g.edge === "child") {
                    const momId = wifeIdByName[(childMother[name.trim()] || "").trim()];
                    if (momId && momId !== ids[i])
                        newRelations.push({ id: `k-${Date.now()}-mom-${ids[i]}`, groupId, source: momId, target: ids[i], type: "parent" });
                }
            });
        });
        setGroupPersons((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), ...newPersons, ...extraPersons] }));
        // نُسقط أي علاقة ذاتية أو مكرّرة قد تنشأ عند الربط بأشخاص موجودين
        setKinshipRelations((prev) => {
            const seen = new Set(prev.map((r) => `${r.groupId}|${[r.source, r.target].sort().join("-")}`));
            const accepted = [];
            newRelations.forEach((r) => {
                if (r.source === r.target)
                    return;
                const key = `${r.groupId}|${[r.source, r.target].sort().join("-")}`;
                if (seen.has(key))
                    return;
                seen.add(key);
                accepted.push(r);
            });
            // نستنتج زواج الوالدين، ثم نُسري الأبوّة على الإخوة
            let out = [...prev, ...accepted];
            const childIds = new Set(accepted.filter((r) => r.type === "parent").map((r) => r.target));
            childIds.forEach((cid) => {
                const sp = inferSpouseFromParents(groupId, cid, out);
                if (sp)
                    out = [...out, sp];
            });
            const touched = new Set([
                ...childIds,
                ...accepted.filter((r) => r.type === "sibling").flatMap((r) => [r.source, r.target]),
            ]);
            touched.forEach((pid) => {
                out = [...out, ...inferParentsForSiblings(groupId, pid, out)];
            });
            return out;
        });
        const createdCount = newPersons.length + extraPersons.length;
        const totalNames = chainNames.length + brothers.length + sisters.length + sons.length + daughters.length + wives.length;
        const reusedCount = totalNames - createdCount;
        logActivity(groupId, `أضافت ${createdCount} قريب بالنسب المتسلسل (${chainNames[0] || t("ai_bla_asm")})` + (reusedCount ? t("wrbtt_mwjwda", { reusedCount }) : ""));
        showToast(reusedCount
            ? t("adyf_qryb_wrbt_mwjwda", { createdCount, reusedCount })
            : t("tmt_idafa_qryb_wrbthm", { createdCount }), "success");
    }
    // إضافة عدة أقارب دفعة واحدة لشخص محدَّد — من الشجرة أو من قائمة الأفراد
    function addRelativesBulk(groupId, person, sel, names, decisions = {}) {
        const relKey = sel.key;
        // الصلة نسبةً لصاحب الشجرة لا للشخص المُضاف إليه
        const rawAnchor = (groupPersons[groupId] || []).find((x) => x.id === person.id) || person;
        const derived = kinPreview(groupPersons[groupId] || [], kinshipRelations.filter((r) => r.groupId === groupId), rawAnchor, relKey, sel.gender) || deriveKinship(rawAnchor.kinship, relKey, sel.gender);   // C75
        const existing = groupPersons[groupId] || [];
        const reusedId = (n) => {
            var _a;
            if (decisions[n.trim().toLowerCase()] !== "same")
                return null;
            return ((_a = existing.find((p) => p.local_name.trim().toLowerCase() === n.trim().toLowerCase())) === null || _a === void 0 ? void 0 : _a.id) || null;
        };
        const ids = names.map((n) => reusedId(n) || `gp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
        const created = names
            .map((n, i) => (reusedId(n) ? null : {
            id: ids[i], local_name: n, kinship: derived, gender: sel.gender,
            proximity: proximityForKinship(derived), alive: true, favorite: false, locations: [],
            lastContactDate: null, addedAt: Date.now(), contacts: null, notes: "", linkedTo: null,
        }))
            .filter(Boolean);
        // اتجاه العلاقة من منظور صاحب البطاقة
        const edges = ids.map((id) => relKey === "parent" ? { source: id, target: person.id, type: "parent" }
            : relKey === "child" ? { source: person.id, target: id, type: "parent" }
                : (relKey === "sibling" && sel.half) ? { source: person.id, target: id, type: "sibling", half: sel.half }   // C75
                    : { source: person.id, target: id, type: relKey });
        // حدّ الوالدين: لا يتجاوز اثنين مع الموجود سلفاً
        if (relKey === "parent") {
            const already = kinshipRelations.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === person.id).length;
            if (already + ids.length > 2) {
                showToast(t("la_ymkn_tjawz_waldyn"), "error");
                return;
            }
        }
        // حدود الزواج — تُحسب على العلاقات الحالية فقط، والسابقة بلا حدّ
        // لأنها توثيق تاريخي قد يتضمن زيجات متعددة متعاقبة.
        if (relKey === "spouse") {
            const currentSpouses = kinshipRelations.filter((r) => r.groupId === groupId && r.type === "spouse"
                && (r.source === person.id || r.target === person.id)).length;
            // المرأة: زوج واحد. الرجل: حتى أربع.
            const limit = sel.gender === "male" ? 1 : 4;
            if (currentSpouses + ids.length > limit) {
                showToast(limit === 1 ? t("ai_la_akthr_zwj") : t("ai_la_akthr_zwjat"), "error");
                return;
            }
        }
        setGroupPersons((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), ...created] }));
        setKinshipRelations((prev) => {
            const seen = new Set(prev.map((r) => `${r.groupId}|${[r.source, r.target].sort().join("-")}`));
            const accepted = [];
            edges.forEach((e) => {
                if (e.source === e.target)
                    return;
                const key = `${groupId}|${[e.source, e.target].sort().join("-")}`;
                if (seen.has(key))
                    return;
                seen.add(key);
                accepted.push({ id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, groupId, ...e });
            });
            // نستنتج زواج الوالدين، ثم نُسري الأبوّة على الإخوة
            let out = [...prev, ...accepted];
            if (relKey === "child") ids.forEach((cid) => { const cop = coParentEdge(groupId, person.id, cid, out, sel.coParent); if (cop) out = [...out, cop]; });   // C81
            const childIds = new Set(accepted.filter((r) => r.type === "parent").map((r) => r.target));
            childIds.forEach((cid) => {
                const sp = inferSpouseFromParents(groupId, cid, out);
                if (sp)
                    out = [...out, sp];
            });
            const touched = new Set([
                ...childIds,
                ...accepted.filter((r) => r.type === "sibling").flatMap((r) => [r.source, r.target]),
            ]);
            touched.forEach((pid) => {
                out = [...out, ...inferParentsForSiblings(groupId, pid, out)];
            });
            return out;
        });
        const reused = names.length - created.length;
        logActivity(groupId, t("adaft_qryb_l", { length: created.length, local_name: person.local_name }) + (reused ? t("wrbtt_mwjwda_2", { reused }) : ""));
        showToast(reused ? t("adyf_wrbt_mwjwda_b", { length: created.length, reused, local_name: person.local_name })
            : t("adyf_qryb_l", { length: created.length, local_name: person.local_name }), "success");
    }
    function logActivity(groupId, text) {
        setActivityLog((prev) => [{ id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, groupId, text, ts: Date.now() }, ...(prev || [])].slice(0, 300));
    }
    // C81: ابنٌ يُضاف لشخصٍ متزوّج ⇒ زوجه الحاليّ الوحيد والده الآخر تلقائيّاً.
    //      كان يُربط بأحد الوالدين فقط، فيظهر أبناء العمّة (زوجة الخال) «أبناءَها من زواجٍ آخر» لا أبناء الخال.
    //      مع أكثر من زوج/زوجة لا نخمّن — يُختار في «إضافة أقارب» أو لاحقاً من «تغيير الأب/الأم».
    function coParentEdge(groupId, parentId, childId, rels, explicit) {
        if (explicit === "none") return null;
        const list = groupPersons[groupId] || [];
        const g = (id) => ((list.find((p) => p.id === id) || {}).gender === "female" ? "female" : "male");
        let other = explicit || null;
        if (!other) {
            const cur = rels.filter((r) => r.groupId === groupId && r.type === "spouse" && (r.source === parentId || r.target === parentId)).map((r) => (r.source === parentId ? r.target : r.source));
            if (cur.length !== 1) return null;
            other = cur[0];
        }
        if (!other || other === childId || g(other) === g(parentId)) return null;
        const ps = rels.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === childId).map((r) => r.source);
        if (ps.length >= 2 || ps.indexOf(other) >= 0 || ps.some((p) => p !== parentId && g(p) === g(other))) return null;
        return { id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-cop`, groupId, source: other, target: childId, type: "parent" };
    }
    function addPerson(groupId, data) {
        var _a;
        const { relation, linkedTo, ancestorChain, ...personData } = data;
        const newPersonId = `gp-${Date.now()}`;
        // نسب مكتوب في الاسم: نُنشئ الأصول الناقصة ونربطها صعوداً.
        // الموجود منهم يُعاد استعماله بدل إنشاء نسخة مكرّرة.
        const existing = groupPersons[groupId] || [];
        const ancestorIds = [];
        const newAncestors = [];
        // مطابقة الأصول بالنسب لا بالاسم وحده: «إبراهيم بن البشير» ليس
        // «إبراهيم بن محمد» وإن تشابه الاسم. نتحقق أن والد المرشّح يطابق
        // الاسم التالي في السلسلة المُدخلة قبل إعادة استعماله.
        const parentNameOf = (pid) => {
            var _a, _b;
            const rel = kinshipRelations.find((r) => r.groupId === groupId && r.type === "parent" && r.target === pid);
            if (!rel)
                return null;
            return ((_b = (_a = existing.find((p) => p.id === rel.source)) === null || _a === void 0 ? void 0 : _a.local_name) === null || _b === void 0 ? void 0 : normalizeArabicName(_b)) || null;
        };
        (ancestorChain || []).forEach((nm, i) => {
            const expectedParent = (ancestorChain[i + 1] || "").trim(); // الاسم الأعلى في السلسلة
            const sameName = existing.filter((p) => normalizeArabicName(p.local_name) === normalizeArabicName(nm));   // C74: أحمد = احمد
            let found = null;
            if (sameName.length === 1 && !expectedParent) {
                // اسم فريد ولا سلف بعده — نقبله
                found = sameName[0];
            }
            else if (expectedParent) {
                // نقبل من يطابق والده الاسم المتوقَّع، أو من لا والد له بعد
                found = sameName.find((p) => parentNameOf(p.id) === normalizeArabicName(expectedParent))
                    || sameName.find((p) => parentNameOf(p.id) === null) || null;
            }
            else if (sameName.length > 1) {
                // متشابهون بلا سلف يميّزهم — لا نُخاطر بالدمج
                found = null;
            }
            if (found) {
                ancestorIds.push(found.id);
                return;
            }
            const id = `gp-${Date.now()}-a${i}`;
            ancestorIds.push(id);
            // C33: أصول السلسلة هي أصول الشخص المُضاف لا أصولي: «الوالد/الجد» فقط حين يكون المُضاف أنا أو أخي/أختي (أصولنا واحدة)؛
            //      وإلّا تُسجَّل «أخرى» وتُضبط يدويّاً (كان ابن العم يُضيف أباه «والداً» لي). ولا نحكم بوفاة أحدٍ من عندنا.
            const shared = !personData.kinship || ["نفسي", "الأخ", "الأخت"].indexOf(personData.kinship) >= 0;
            const kin = shared ? (i === 0 ? "الوالد" : i === 1 ? "الجد" : "أخرى") : "أخرى";
            newAncestors.push({
                id, local_name: nm, kinship: kin,
                gender: "male", // الأصول في النسب ذكور
                proximity: proximityForKinship(kin),
                alive: true, favorite: false, locations: [],
                lastContactDate: null, addedAt: Date.now(), contacts: null, notes: "", linkedTo: null,
            });
        });
        const newPerson = {
            id: newPersonId, alive: true, favorite: false, locations: [],
            lastContactDate: null, addedAt: Date.now(), // C74: الإضافة ليست تواصلاً — وقتها مرجعٌ للتذكير فقط
            linkedTo: linkedTo || null,
            ...personData,
        };
        setGroupPersons((prev) => ({ ...prev, [groupId]: [...(prev[groupId] || []), newPerson, ...newAncestors] }));
        // ربط سلسلة النسب: الشخص ← والده ← جده …
        if (ancestorIds.length) {
            setKinshipRelations((prev) => {
                let next = [...prev];
                const chain = [newPersonId, ...ancestorIds];
                for (let i = 0; i < chain.length - 1; i++) {
                    const child = chain[i], parent = chain[i + 1];
                    const dup = next.some((r) => r.groupId === groupId && r.type === "parent"
                        && r.source === parent && r.target === child);
                    if (dup)
                        continue;
                    const cnt = next.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === child).length;
                    if (cnt >= 2)
                        continue;
                    next.push({ id: `k-${Date.now()}-c${i}`, groupId, source: parent, target: child, type: "parent", inferred: "inherited" });
                }
                // نُسري الأبوّة على إخوة كل حلقة
                chain.forEach((id) => { next = [...next, ...inferParentsForSiblings(groupId, id, next)]; });
                return next;
            });
        }
        if (relation === null || relation === void 0 ? void 0 : relation.relatedToId) {
            // نربط العلاقة فوراً بنفس لحظة الإضافة — يحل مشكلة "القريب ما ينزل
            // بالشجرة" لأنه ببساطة ما كان مرتبطاً بأي علاقة فعلية من قبل
            const edge = resolveRelationEdge(newPersonId, relation.relatedToId, relation.relationType);
            setKinshipRelations((prev) => {
                // C33: مسار النموذج كان يتجاوز حارس الوالدَين (ثلاثة آباء لابنٍ واحد)
                if (edge.type === "parent" && prev.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === edge.target).length >= 2) {
                    setTimeout(() => showToast(t("lhdha_alshkhs_waldan_msjlan"), "error"), 0);
                    return prev;
                }
                let next = [...prev, { id: `k-${Date.now()}`, groupId, source: edge.source, target: edge.target, type: edge.type }];
                if (edge.type === "parent" && edge.source === relation.relatedToId) {
                    const cop = coParentEdge(groupId, edge.source, edge.target, next);   // C81
                    if (cop) next = [...next, cop];
                }
                if (edge.type === "parent") {
                    const sp = inferSpouseFromParents(groupId, edge.target, next);
                    if (sp)
                        next = [...next, sp];
                    next = [...next, ...inferParentsForSiblings(groupId, edge.target, next)];
                }
                else if (edge.type === "sibling") {
                    next = [...next, ...inferParentsForSiblings(groupId, edge.target, next)];
                }
                return next;
            });
        }
        if (linkedTo)
            applyCrossGroupLink(groupId, newPersonId, linkedTo, (_a = personData.contacts) === null || _a === void 0 ? void 0 : _a.phone, personData.birthday);
        logActivity(groupId, t("adft_local_name", { local_name: data.local_name }));
        showToast(newAncestors.length
            ? t("adyf_w_mn_aswlh", { local_name: personData.local_name, length: newAncestors.length })
            : `تمت إضافة ${personData.local_name}${(relation === null || relation === void 0 ? void 0 : relation.relatedToId) ? t("ai_wrbtha") : " ✓"}`, "success");
    }
    function editPerson(groupId, personId, data) {
        var _a;
        const { linkedTo, motherApplicable, motherId, motherCandidateIds, kinLabel, kinAlso, kinComputed, kinStored, kinSection, ...personData0 } = data;
        // C75: القرابة المعروضة محسوبةٌ من منظورك — لا تُكتب فوق المخزَّنة (وإلّا كتب المنضمّ منظوره عند الجميع).
        //      تُحفظ فقط إن غيّرها المستخدم فعلاً لشخصٍ بلا طريقٍ في الشجرة.
        const viewP = ((famPersons[groupId] || []).find((p) => p.id === personId)) || {};
        const personData = { ...personData0 };
        if (viewP.kinComputed && personData.kinship === viewP.kinship) { delete personData.kinship; delete personData.proximity; }
        if (viewP.kinComputed && personData.proximity === viewP.proximity) delete personData.proximity;
        // حافة الأمومة تُوفَّق هنا لا في بيانات الشخص: نحذف أيّ أمومة من
        // زوجات الأب ثم نضيف المختارة. لا نمسّ أبوّة الأب ولا غيرها.
        if (motherApplicable) {
            setKinshipRelations((prev) => {
                const cleaned = prev.filter((r) => !(r.groupId === groupId && r.type === "parent" && r.target === personId && (motherCandidateIds || []).includes(r.source)));
                return motherId
                    ? [...cleaned, { id: `k-${Date.now()}-mom-${personId}`, groupId, source: motherId, target: personId, type: "parent" }]
                    : cleaned;
            });
        }
        setGroupPersons((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((p) => (p.id === personId ? { ...p, ...personData, linkedTo: linkedTo || null } : p)),
        }));
        if (linkedTo)
            applyCrossGroupLink(groupId, personId, linkedTo, (_a = personData.contacts) === null || _a === void 0 ? void 0 : _a.phone, personData.birthday);
        logActivity(groupId, t("adlt_byanat", { local_name: data.local_name }));
        showToast(`تم حفظ التعديلات${linkedTo ? t("ai_wtmt_almzamna") : " ✓"}`, "success");
    }
    function quickUpdateStatus(groupId, personId, statusValue) {
        setGroupPersons((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((p) => (p.id === personId ? { ...p, status_detail: statusValue } : p)),
        }));
        showToast(t("tm_thdyth_alhala"), "success");
    }
    function deletePerson(groupId, personId) {
        var _a;
        const personName = ((_a = (groupPersons[groupId] || []).find((p) => p.id === personId)) === null || _a === void 0 ? void 0 : _a.local_name) || t("ai_qryb");
        setGroupPersons((prev) => ({ ...prev, [groupId]: (prev[groupId] || []).filter((p) => p.id !== personId) }));
        // تنظيف كل ما يشير للشخص المحذوف — وإلا بقيت روابط يتيمة تكسر الشجرة
        const orphanRels = kinshipRelations.filter((r) => r.groupId === groupId && (r.source === personId || r.target === personId)).length;
        setKinshipRelations((prev) => prev.filter((r) => !(r.groupId === groupId && (r.source === personId || r.target === personId))));
        setSchedules((prev) => prev.filter((s) => !(s.groupId === groupId && s.personId === personId)));
        setEvents((prev) => prev.filter((e) => !(e.groupId === groupId && e.personId === personId)));
        logActivity(groupId, orphanRels ? t("hdhft_w_alaqa", { personName, orphanRels }) : t("hdhft", { personName }));
        showToast(orphanRels ? t("tm_hdhf_w_alaqa", { personName, orphanRels }) : t("ai_tm_alhdhf"), "success");
    }
    function mergePersons(keepId, removeId) {
        const groupId = Object.keys(groupPersons).find((gid) => (groupPersons[gid] || []).some((p) => p.id === removeId));
        if (!groupId)
            return;
        const keepPerson = (groupPersons[groupId] || []).find((p) => p.id === keepId);
        const removePerson = (groupPersons[groupId] || []).find((p) => p.id === removeId);
        if (!keepPerson || !removePerson)
            return;
        // نعيد توجيه كل علاقة كانت تشير للمكرّر لتشير للأصلي بدلاً عنه، ونحذف
        // أي علاقة تصبح ذاتية (شخص مرتبط بنفسه) أو مكرّرة بعد إعادة التوجيه
        setKinshipRelations((prev) => {
            const redirected = prev.map((r) => ({
                ...r,
                source: r.source === removeId ? keepId : r.source,
                target: r.target === removeId ? keepId : r.target,
            }));
            const seen = new Set();
            return redirected.filter((r) => {
                if (r.source === r.target)
                    return false; // علاقة ذاتية بعد إعادة التوجيه — نتجاهلها
                const key = `${r.groupId}|${[r.source, r.target].sort().join("-")}|${r.type}`;
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
        });
        // نفس التوجيه للمواعيد والأحداث المرتبطة بالمكرّر
        setSchedules((prev) => prev.map((s) => (s.personId === removeId ? { ...s, personId: keepId } : s)));
        setEvents((prev) => prev.map((e) => (e.personId === removeId ? { ...e, personId: keepId } : e)));
        // دمج البيانات — الأصلي يحتفظ بقيمه، ويُكمَّل بقيم المكرّر لو الأصلي ناقصها
        setGroupPersons((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || [])
                .filter((p) => p.id !== removeId)
                .map((p) => p.id !== keepId ? p : {
                ...p,
                contacts: p.contacts || removePerson.contacts,
                birthday: p.birthday || removePerson.birthday,
                birthYear: p.birthYear || removePerson.birthYear,
                photo: p.photo || removePerson.photo,
                notes: p.notes || removePerson.notes,
                status_detail: p.status_detail || removePerson.status_detail,
            }),
        }));
        logActivity(groupId, t("dmjt_b", { from: removePerson.local_name, into: keepPerson.local_name }));
        showToast(t("tm_dmj_b", { from: removePerson.local_name, into: keepPerson.local_name }), "success");
    }
    // يتحقّق: لو ضفنا "sourceId أب لـ targetId"، هل sourceId أصلاً أحد أحفاد
    // targetId (عبر سلسلة أب/ابن موجودة مسبقاً)؟ لو نعم، هذي الإضافة تقفل
    // حلقة دائرية لا نهائية بالشجرة (كل واحد جد للثاني بنفس الوقت) — نمنعها
    function wouldCreateParentCycle(groupId, proposedParentId, proposedChildId) {
        const parentEdgesInGroup = kinshipRelations.filter((r) => r.groupId === groupId && r.type === "parent");
        const descendants = new Set();
        const queue = [proposedChildId];
        while (queue.length > 0) {
            const current = queue.pop();
            parentEdgesInGroup.forEach((r) => {
                if (r.source === current && !descendants.has(r.target)) {
                    descendants.add(r.target);
                    queue.push(r.target);
                }
            });
        }
        return descendants.has(proposedParentId);
    }
    // والدا الشخص الواحد زوجان بالضرورة — نستنتج الرابط تلقائياً.
    // بدونه يظهر كلٌّ منهما جذراً مستقلاً في كتلة منفصلة (كحال الجدة
    // المضافة كأمٍّ لوالدك بينما جدّك مسجَّل أباً له).
    function inferSpouseFromParents(groupId, childId, relsSnapshot) {
        const parentsOfChild = relsSnapshot
            .filter((r) => r.groupId === groupId && r.type === "parent" && r.target === childId)
            .map((r) => r.source);
        if (parentsOfChild.length !== 2)
            return null;
        const [a, b] = parentsOfChild;
        // لا نُنشئ الرابط إن كان موجوداً بأي اتجاه أو نوع
        const exists = relsSnapshot.some((r) => r.groupId === groupId
            && (r.type === "spouse" || r.type === "ex_spouse")
            && ((r.source === a && r.target === b) || (r.source === b && r.target === a)));
        if (exists)
            return null;
        return { id: `k-${Date.now()}-sp`, groupId, source: a, target: b, type: "spouse", inferred: "parents-spouse" };
    }
    // من كان أخاً لشخص، فوالدا ذلك الشخص والداه. نشتقّ الأبوّة الناقصة
    // تلقائياً — وإلا ظهر الإخوة بلا والد رغم ارتباطهم بمن له والد.
    // C75: الأخوّة غير الشقيقة (half) لا تنقل إلّا والدها المشترك — «من الأب» ينقل الأب وحده
    function inferParentsForSiblings(groupId, personId, relsSnapshot) {
        const full = inferParentsForSiblingsFull(groupId, personId, relsSnapshot);
        const all = [...relsSnapshot, ...full], added = [];
        const genderOf = (id) => { const p = (groupPersons[groupId] || []).find((x) => x.id === id); return p && p.gender; };
        all.filter((r) => r.groupId === groupId && r.type === "sibling" && r.half && (r.source === personId || r.target === personId)).forEach((r) => {
            const want = r.half === "mother" ? "female" : "male";
            const parentOf = (id) => [...all, ...added].find((x) => x.groupId === groupId && x.type === "parent" && x.target === id && genderOf(x.source) === want);
            [[r.source, r.target], [r.target, r.source]].forEach(([a, b]) => {
                const pa = parentOf(a);
                if (!pa || parentOf(b)) return;
                added.push({ id: `k-${Date.now()}-${added.length}-half`, groupId, source: pa.source, target: b, type: "parent", inferred: "half-sibling-parent" });
            });
        });
        return [...full, ...added];
    }
    function inferParentsForSiblingsFull(groupId, personId, relsSnapshot) {
        const sibEdges = relsSnapshot
            .filter((r) => r.groupId === groupId && r.type === "sibling" && !r.half)
            .map((r) => [r.source, r.target]);
        // كل من يتصل به عبر سلسلة أخوّة
        const group = new Set([personId]);
        const queue = [personId];
        while (queue.length) {
            const cur = queue.pop();
            sibEdges.forEach(([a, b]) => {
                if (a === cur && !group.has(b)) {
                    group.add(b);
                    queue.push(b);
                }
                if (b === cur && !group.has(a)) {
                    group.add(a);
                    queue.push(a);
                }
            });
        }
        if (group.size < 2)
            return [];
        // والدا المجموعة: نجمع كل من سُجِّل أباً أو أماً لأيٍّ منهم
        const parentsOfGroup = new Set();
        relsSnapshot
            .filter((r) => r.groupId === groupId && r.type === "parent" && group.has(r.target))
            .forEach((r) => parentsOfGroup.add(r.source));
        if (parentsOfGroup.size === 0)
            return [];
        // ⛔ تعدّد الزوجات: من كان زوجه متزوّجاً بأكثر من واحد، فإخوة أبنائه
        // قد يكونون غير أشقاء — والأمومة غير قابلة للاستنتاج. نُسري الأب
        // (زوجه واحد فيهم) ولا نُسري الزوجة المشارِكة.
        const spouseTouch = {};
        relsSnapshot
            .filter((r) => r.groupId === groupId && (r.type === "spouse" || r.type === "ex_spouse"))
            .forEach((r) => {
            spouseTouch[r.source] = (spouseTouch[r.source] || 0) + 1;
            spouseTouch[r.target] = (spouseTouch[r.target] || 0) + 1;
        });
        const spousesOfId = (id) => relsSnapshot
            .filter((r) => r.groupId === groupId && (r.type === "spouse" || r.type === "ex_spouse") && (r.source === id || r.target === id))
            .map((r) => (r.source === id ? r.target : r.source));
        const added = [];
        parentsOfGroup.forEach((parentId) => {
            if (spousesOfId(parentId).some((sid) => (spouseTouch[sid] || 0) >= 2))
                return;
            group.forEach((childId) => {
                if (childId === parentId)
                    return;
                const exists = [...relsSnapshot, ...added].some((r) => r.groupId === groupId && r.type === "parent"
                    && r.source === parentId && r.target === childId);
                if (exists)
                    return;
                // لا نتجاوز والدين لكل طفل
                const count = [...relsSnapshot, ...added].filter((r) => r.groupId === groupId && r.type === "parent" && r.target === childId).length;
                if (count >= 2)
                    return;
                added.push({ id: `k-${Date.now()}-${added.length}-inh`, groupId, source: parentId, target: childId, type: "parent", inferred: "sibling-parent" });
            });
        });
        return added;
    }
    // إصلاح شامل للمجموعة: يربط الوالدين بزواج، ويُسري الأبوّة على الإخوة.
    // يُستدعى يدوياً من زر الإصلاح، وتلقائياً عند فتح الشجرة.
    function inferSpousesAndParents(gid, silent = false) {
        setKinshipRelations((prev) => {
            let out = prev;
            // جولة أولى: الأبوّة المفقودة للإخوة
            const inherited = [];
            (groupPersons[gid] || []).forEach((p) => {
                inferParentsForSiblings(gid, p.id, [...out, ...inherited]).forEach((r) => inherited.push(r));
            });
            if (inherited.length)
                out = [...out, ...inherited];
            // جولة ثانية: زواج الوالدين (قد تكتمل بعد الجولة الأولى)
            const spouses = [];
            const byChild = {};
            out.filter((r) => r.groupId === gid && r.type === "parent")
                .forEach((r) => { var _a; var _b; ((_a = byChild[_b = r.target]) !== null && _a !== void 0 ? _a : (byChild[_b] = [])).push(r.source); });
            Object.values(byChild).forEach((ps) => {
                if (ps.length !== 2)
                    return;
                const [a, b] = ps;
                const has = [...out, ...spouses].some((r) => r.groupId === gid
                    && (r.type === "spouse" || r.type === "ex_spouse")
                    && ((r.source === a && r.target === b) || (r.source === b && r.target === a)));
                if (!has)
                    spouses.push({ id: `k-${Date.now()}-s${spouses.length}`, groupId: gid, source: a, target: b, type: "spouse", inferred: "parents-spouse" });
            });
            if (spouses.length)
                out = [...out, ...spouses];
            const total = inherited.length + spouses.length;
            if (!silent) {
                showToast(total ? t("aslh_rabta_zwaj_abwa", { total, spouses: spouses.length, parents: inherited.length }) : t("ai_kl_alrwabt"), "success");
            }
            else if (total) {
                showToast(t("rbt_rabta_naqsa_tlqayya", { total }), "info");
            }
            return out;
        });
    }
    function addKinshipRelation(groupId, sourceId, targetId, type) {
        var _a, _b;
        // لا يمكن ربط الشخص بنفسه بأي نوع علاقة
        if (sourceId === targetId) {
            showToast(t("la_ymkn_rbt_alshkhs"), "error");
            return;
        }
        // حدّ الوالدين: أب واحد وأم واحدة. الروابط الأخرى (زوج الأم مثلاً)
        // تُوثَّق كعلاقة زواج مع أحد الوالدين لا كأبوّة مباشرة.
        if (type === "parent") {
            const existingParents = kinshipRelations.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === targetId);
            if (existingParents.length >= 2) {
                showToast(t("lhdha_alshkhs_waldan_msjlan"), "error");
                return;
            }
        }
        // حماية من التضارب — منع علاقتين متعارضتين بين نفس الشخصين (مثل: أب
        // وأخ بنفس الوقت)، أو تكرار نفس العلاقة بالضبط
        const conflict = kinshipRelations.find((r) => {
            if (r.groupId !== groupId)
                return false;
            const sameParties = (r.source === sourceId && r.target === targetId) || (r.source === targetId && r.target === sourceId);
            return sameParties;
        });
        if (conflict) {
            showToast(t("fyh_alaqa_msjla_asla"), "error");
            return;
        }
        if (type === "parent" && wouldCreateParentCycle(groupId, sourceId, targetId)) {
            showToast(t("la_ymkn_itmam_hdha"), "error");
            return;
        }
        const newRelation = { id: `k-${Date.now()}`, groupId, source: sourceId, target: targetId, type };
        setKinshipRelations((prev) => {
            let next = [...prev, newRelation];
            if (type === "parent") {
                const sp = inferSpouseFromParents(groupId, targetId, next);
                if (sp)
                    next = [...next, sp];
                // الأبوّة الجديدة تسري على إخوة الطفل
                next = [...next, ...inferParentsForSiblings(groupId, targetId, next)];
            }
            else if (type === "sibling") {
                // الأخوّة الجديدة ترث والدَي الطرف الآخر
                next = [...next, ...inferParentsForSiblings(groupId, targetId, next)];
            }
            return next;
        });
        const sourceName = ((_a = (groupPersons[groupId] || []).find((p) => p.id === sourceId)) === null || _a === void 0 ? void 0 : _a.local_name) || t("ai_shkhs");
        const targetName = ((_b = (groupPersons[groupId] || []).find((p) => p.id === targetId)) === null || _b === void 0 ? void 0 : _b.local_name) || t("ai_shkhs");
        logActivity(groupId, t("rbtt_alaqa_qraba_byn", { sourceName, targetName }));
        showToast(t("tm_rbt_alalaqa"), "success");
    }
    // C79: تغيير أب/أمّ شخصٍ واحد (أو إزالته) — حذف حافّة الوالد من ذلك الجنس ثمّ إضافة الجديدة
    // C81: إصلاح «أبناء زوجته من زواجٍ آخر» حين يكونون أبناءه هو أيضاً — يُضاف والداً لمن ليس له والدٌ من جنسه
    function claimChildren(groupId, parentId, kidIds) {
        const list = groupPersons[groupId] || [];
        const g = (id) => ((list.find((p) => p.id === id) || {}).gender === "female" ? "female" : "male");
        let added = 0;
        setKinshipRelations((prev) => {
            let next = [...prev];
            kidIds.forEach((kid) => {
                const ps = next.filter((r) => r.groupId === groupId && r.type === "parent" && r.target === kid).map((r) => r.source);
                if (ps.length >= 2 || ps.indexOf(parentId) >= 0 || ps.some((p) => g(p) === g(parentId))) return;
                if (wouldCreateParentCycle(groupId, parentId, kid)) return;
                next = [...next, { id: `k-${Date.now()}-${kid}-claim`, groupId, source: parentId, target: kid, type: "parent" }];
                added++;
            });
            return next;
        });
        const pn = (list.find((p) => p.id === parentId) || {}).local_name || "";
        logActivity(groupId, tl("رُبط أبناءٌ بوالدهم " + pn, "Children linked to " + pn));
        showToast(tl("تمّ — صاروا أبناء " + pn + " أيضاً", "Linked"), "success");
    }
    function changeParent(groupId, childId, gender, newParentId) {
        const list = groupPersons[groupId] || [];
        const genderOf = (id) => ((list.find((p) => p.id === id) || {}).gender === "female" ? "female" : "male");
        const want = gender === "female" ? "female" : "male";
        if (newParentId && wouldCreateParentCycle(groupId, newParentId, childId)) { showToast(t("la_ymkn_itmam_hdha"), "error"); return; }
        if (newParentId && kinshipRelations.some((r) => r.groupId === groupId && r.type !== "parent" && ((r.source === newParentId && r.target === childId) || (r.source === childId && r.target === newParentId)))) {
            showToast(t("fyh_alaqa_msjla_asla"), "error"); return;
        }
        setKinshipRelations((prev) => {
            let next = prev.filter((r) => !(r.groupId === groupId && r.type === "parent" && r.target === childId && genderOf(r.source) === want));
            if (newParentId) {
                next = [...next, { id: `k-${Date.now()}-cp`, groupId, source: newParentId, target: childId, type: "parent" }];
                const sp = inferSpouseFromParents(groupId, childId, next);
                if (sp) next = [...next, sp];
            }
            return next;
        });
        const cn = (list.find((p) => p.id === childId) || {}).local_name || t("ai_shkhs");
        const pn = newParentId ? ((list.find((p) => p.id === newParentId) || {}).local_name || "") : "";
        logActivity(groupId, newParentId ? tl((want === "female" ? "صارت أمّ " : "صار أبو ") + cn + ": " + pn, cn + "'s parent changed") : tl("أُزيل ربط " + (want === "female" ? "أمّ " : "أبي ") + cn, "Parent link removed"));
        showToast(newParentId ? tl("تمّ — " + pn + (want === "female" ? " أمّ " : " أبو ") + cn, "Done") : tl("أُزيل الربط", "Link removed"), "success");
    }
    function deleteKinshipRelation(relationId) {
        var _a, _b;
        const relation = kinshipRelations.find((r) => r.id === relationId);
        if (!relation)
            return;
        setKinshipRelations((prev) => prev.filter((r) => r.id !== relationId));
        const sourceName = ((_a = (groupPersons[relation.groupId] || []).find((p) => p.id === relation.source)) === null || _a === void 0 ? void 0 : _a.local_name) || t("ai_shkhs");
        const targetName = ((_b = (groupPersons[relation.groupId] || []).find((p) => p.id === relation.target)) === null || _b === void 0 ? void 0 : _b.local_name) || t("ai_shkhs");
        logActivity(relation.groupId, t("hdhft_alaqa_alqraba_byn", { sourceName, targetName }));
        showToast(t("tm_hdhf_alalaqa"), "success");
    }
    // ⛔ الطلاق يقع بعد التسجيل لا قبله. وحقيقة الزواج المنتهي في موضعين
    // منذ v157 — نوعُ العلاقة وصلةُ الشخص — فتُضبطان معاً في حركة واحدة،
    // وإلا رسمت الشجرة خطاً متقطّعاً بينما البطاقة تقول «الزوجة».
    // ⛔ الموقعان أصلان مختلفان، فـ localStorage منفصل وشجرتاهما لا تريان
    // بعضهما. هذا الجسر هو السبيل الوحيد لنقل الشجرة بينهما.
    function countPersons(byGroup) {
        return Object.keys(byGroup || {}).reduce((n, k) => n + ((byGroup[k] || []).length), 0);
    }
    // الحمولة والتحقّق منها دالّتان نقيّتان: يُختبران بلا DOM، ويضمن
    // الفحص أنّ ما نُصدّره يجتاز ما نستورده — وإلا صُدِّر ملفّ لا يُقبل.
    function buildTreeExport(groups, persons, relations, app) {
        return {
            format: "sawa-rahim-tree", // ⛔ مُعرِّف الصيغة
            version: 1,
            exportedAt: new Date().toISOString(),
            app: app,
            groups: groups,
            persons: persons,
            relations: relations,
        };
    }
    function isValidTreeFile(data) {
        return !!data
            && data.format === "sawa-rahim-tree"
            && Array.isArray(data.groups)
            && !!data.persons && typeof data.persons === "object" && !Array.isArray(data.persons)
            && Array.isArray(data.relations);
    }
    function exportFamilyTree() {
        const total = countPersons(groupPersons);
        if (!total) {
            showToast(t("ex_la_shy"), "error");
            return;
        }
        const payload = buildTreeExport(familyGroups, groupPersons, kinshipRelations, SAWA_APP);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "sila-" + new Date().toISOString().slice(0, 10) + ".json"; // ⛔ اسم ملف
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(t("ex_tm_altsdyr", { n: total.toLocaleString(loc()) }), "success");
    }
    function importFamilyTree() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json"; // ⛔ نوع MIME
        input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f)
                return;
            const reader = new FileReader();
            reader.onerror = () => showToast(t("ex_talf"), "error");
            reader.onload = () => {
                let data = null;
                try {
                    data = JSON.parse(String(reader.result));
                }
                catch (e) {
                    showToast(t("ex_talf"), "error");
                    return;
                }
                // ملفٌّ من تطبيق آخر يُنتج شجرة نصفها مفقود — يُرفض لا يُرمَّم
                if (!isValidTreeFile(data)) {
                    showToast(t("ex_ghyr_salh"), "error");
                    return;
                }
                const incoming = countPersons(data.persons);
                const current = countPersons(groupPersons);
                // ⛔ استبدالٌ لا دمج: دمج شجرتين من جهازين يوحّد أشخاصاً
                // بمعرّفات مختلفة ولا رجعة فيه. الاستبدال يُفهَم ويُتوقَّع.
                if (!window.confirm(t("ex_takyd", { current: current.toLocaleString(loc()), incoming: incoming.toLocaleString(loc()) })))
                    return;
                setFamilyGroups(data.groups);
                setGroupPersons(data.persons);
                setKinshipRelations(data.relations);
                showToast(t("ex_tm_alastyrad", { n: incoming.toLocaleString(loc()) }), "success");
            };
            reader.readAsText(f);
        };
        input.click();
    }
    function endMarriage(relationId) {
        const relation = kinshipRelations.find((r) => r.id === relationId);
        if (!relation || relation.type !== "spouse")
            return;
        const EX_OF = { "الزوجة": "الزوجة السابقة", "الزوج": "الزوج السابق" }; // ⛔ مُعرِّفات لا نصوص
        const nameOf = (id) => {
            const q = (groupPersons[relation.groupId] || []).find((p) => p.id === id);
            return (q && q.local_name) || t("rs_shkhs_mhdhwf");
        };
        const a = nameOf(relation.source), b = nameOf(relation.target);
        setKinshipRelations((prev) => prev.map((r) => (r.id === relationId ? { ...r, type: "ex_spouse" } : r)));
        setGroupPersons((prev) => ({
            ...prev,
            [relation.groupId]: (prev[relation.groupId] || []).map((p) => {
                if (p.id !== relation.source && p.id !== relation.target)
                    return p;
                // «زوجة الأخ» و«زوجة الابن» لا مفردة منتهية لهما — تبقيان كما هما
                const next = EX_OF[p.kinship];
                return next ? { ...p, kinship: next, proximity: proximityForKinship(next) } : p;
            }),
        }));
        logActivity(relation.groupId, t("ft_anhyt_alzwaj", { a, b }));
        showToast(t("ft_tm_anha_alzwaj"), "success");
    }
    function updateEvent(id, personId, type, title, dateTimestamp, desc) {
        setEvents((prev) => prev.map((e) => (e.id === id
            ? Object.assign({}, e, { personId, type, title, desc: desc || "", dateTimestamp: typeof dateTimestamp === "number" ? dateTimestamp : eventDateTs(e) })
            : e)));
        showToast(t("ev_tm_altadyl"), "success");
    }
    function deleteEvent(id) {
        setEvents((prev) => prev.filter((e) => e.id !== id));
        showToast(t("ev_tm_alhdhf"), "success");
    }
    function markContactNow(groupId, personId) {
        setGroupPersons((prev) => ({
            ...prev,
            [groupId]: (prev[groupId] || []).map((p) => (p.id === personId ? { ...p, lastContactDate: Date.now() } : p)),
        }));
        showToast(t("sjlna_twaslk_alhyn"), "success");
    }
    // ── C37: منازل الأقارب وتنبيه القرب ──
    const [proxEnabled, setProxEnabled] = usePersistedState("ui.proxAlerts", false, 50);
    const [proxRadius, setProxRadius] = usePersistedState("ui.proxRadius", 1000, 50);   // C37b: النطاق العامّ لكلّ الأقارب
    const [proxAlert, setProxAlert] = useState(null);     // { person, gid, dist }
    const [homeSave, setHomeSave] = useState(null);       // { lat, lng, label } من رسالة موقع في المحادثة
    useProximityWatch(proxEnabled && flow === "app", familyGroups, groupPersons, (a) => {
        setProxAlert(a);
        setNotifications((prev) => [{ id: `n-prox-${Date.now()}`, type: "proximity", title: t("tnbyh_alqrb_anwan"), body: t("tnbyh_alqrb_ns", { personName: a.person.local_name }), read: false }, ...prev].slice(0, 50));
        try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) { }
    });
    useEffect(() => { const h = (e) => setHomeSave(e.detail || null); window.addEventListener("sawa-save-home", h); return () => window.removeEventListener("sawa-save-home", h); }, []);
    function setPersonHome(gid, p, c, label) {
        const loc = { type: "home", lat: Number(Number(c.lat).toFixed(6)), lng: Number(Number(c.lng).toFixed(6)), radius_meters: 0, address_text: String(label || "").slice(0, 120) };
        setGroupPersons((prev) => ({ ...prev, [gid]: (prev[gid] || []).map((x) => (x.id === p.id ? { ...x, locations: [loc] } : x)) }));
        logActivity(gid, tl("حُدّد منزل " + p.local_name, "Set home of " + p.local_name));
        showToast(tl("حُفظ منزل " + p.local_name.split(" ")[0] + " ✓", "Saved " + p.local_name + "'s home ✓"), "success");
    }
    function enableProx() {
        geoNow({ enableHighAccuracy: false, maximumAge: 0 }).then(() => { setProxEnabled(true); showToast(tl("فُعّلت تنبيهات القرب ✓", "Proximity alerts on ✓"), "success"); })
            .catch((e) => showToast(e && e.code === 1 ? tl("رُفض إذن الموقع — فعّله من إعدادات المتصفّح للموقع", "Location permission denied") : tl("تعذّر تحديد موقعك الآن", "Couldn't get your location"), "error"));
    }
    const proxSeenSet = (pid, v) => { try { const s = JSON.parse(localStorage.getItem("sawa_prox_seen") || "{}"); s[pid] = v; localStorage.setItem("sawa_prox_seen", JSON.stringify(s)); } catch (e) { } };
    // إنشاء مجموعة أصهار: أهل الزوج/الزوجة في مجموعة مستقلة، والشخص نفسه
    // يوجد في المجموعتين مرتبطاً عبر linkedTo — فيبقى النسب غير مختلط
    // والشجرة الأصلية بجذر واحد، بينما تبقى صلة الرحم شاملة للطرفين.
    function createInLawsGroup(sourceGroupId, person) {
        const newId = `g-${Date.now()}`;
        const groupName = `أهل ${person.local_name.split(" ")[0]}`;
        const bridgeId = `gp-${Date.now()}-bridge`;
        setFamilyGroups((prev) => [...prev, { id: newId, name: groupName, description: "عائلة الأصهار", role: "owner" }]);
        setGroupPersons((prev) => ({
            ...prev,
            // نسخة الشخص داخل مجموعة أهله — نقطة الوصل بين الشجرتين
            [newId]: [{
                    ...person,
                    id: bridgeId,
                    kinship: "أخرى",
                    // الأصهار درجة أوسع افتراضياً — قابلة للتعديل من ملف الشخص
                    // الأصهار درجة أوسع من موقع الشخص في عائلتك
                    proximity: { "A***": "A*", "A**": "A*", "A*": "A", A: "B", B: "C", C: "C" }[person.proximity] || "A",
                    linkedTo: { groupId: sourceGroupId, personId: person.id },
                }],
            // نربط النسخة الأصلية بالمجموعة الجديدة
            [sourceGroupId]: (prev[sourceGroupId] || []).map((p) => p.id === person.id ? { ...p, linkedTo: { groupId: newId, personId: bridgeId } } : p),
        }));
        setMembers((prev) => ({ ...prev, [newId]: [{ userId: "u-1", name: "أنت", role: "owner" }] }));
        setGroupSettings((prev) => ({ ...prev, [newId]: { allowMemberEvents: false } }));
        logActivity(sourceGroupId, t("anshat_mjmwaa_wrbttha_b", { groupName, local_name: person.local_name }));
        showToast(t("anshyt_adf_waldha_wikhwtha", { groupName }), "success");
        // ننتقل مباشرة للمجموعة الجديدة
        setCurrentGroupId(newId);
        setDiscoverStack([{ type: "groups" }, { type: "groupDetail", data: { id: newId, name: groupName, description: "عائلة الأصهار", role: "owner" } }]);
    }
    function renameFamilyGroup(groupId, name) {
        const clean = (name || "").trim();
        if (!clean)
            return;
        setFamilyGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: clean } : g)));
        logActivity(groupId, t("fg_smyt_almjmwaa", { name: clean }));
        showToast(t("fg_tmt_altsmya"), "success");
    }
    // ⛔ أثر المجموعة في تسعة مخازن. إغفال واحدٍ يترك يتامى لا سبيل إليهم
    // ولا حذفهم — وهو العطل نفسه الذي أصلحناه في familyGroups.
    function deleteFamilyGroup(groupId) {
        const personIds = {};
        (groupPersons[groupId] || []).forEach((p) => { personIds[p.id] = true; });
        const dropByGroup = (arr) => (arr || []).filter((x) => x.groupId !== groupId);
        const omitKey = (obj) => { const c = { ...obj }; delete c[groupId]; return c; };
        const omitPersons = (obj) => {
            const c = {};
            Object.keys(obj || {}).forEach((k) => { if (!personIds[k]) c[k] = obj[k]; });
            return c;
        };
        setGroupPersons(omitKey);
        setMembers(omitKey);
        setGroupSettings(omitKey);
        setKinshipRelations(dropByGroup);
        setSchedules(dropByGroup);
        setEvents(dropByGroup);
        setActivityLog(dropByGroup);
        // مفاتيح هذين أشخاصٌ لا مجموعات — تُنظَّف بمعرّفات من حُذفوا
        setFamilyFavorites(omitPersons);
        setDismissedSuggestions(omitPersons);
        const remaining = familyGroups.filter((g) => g.id !== groupId);
        setFamilyGroups(remaining);
        if (currentGroupId === groupId)
            setCurrentGroupId(remaining.length ? remaining[0].id : "");
        setDiscoverStack([]);
        showToast(t("fg_tm_alhdhf"), "success");
    }
    function createFamilyGroup(name) {
        const newId = `g-${Date.now()}`;
        setFamilyGroups((prev) => [...prev, { id: newId, name, description: "", role: "owner" }]);
        setGroupPersons((prev) => ({ ...prev, [newId]: [] }));
        setMembers((prev) => ({ ...prev, [newId]: [{ userId: "u-1", name: "أنت", role: "owner" }] }));
        setGroupSettings((prev) => ({ ...prev, [newId]: { allowMemberEvents: false } }));
        setCurrentGroupId(newId);
    }
    // إتمام التذكير كان يغيّر النص المعروض فقط ويترك dueTimestamp في الماضي،
    // فيبقى التذكير مستحقاً إلى الأبد. نُقدّمه لموعده التالي حسب التكرار.
    function completeSchedule(id) {
        setSchedules((prev) => prev.map((s) => {
            if (s.id !== id)
                return s;
            // ننطلق من الآن لا من الموعد الفائت، وإلا بقي في الماضي
            const next = Date.now() + scheduleFreqDays(scheduleFreqKey(s)) * DAY_MS;
            // ⛔ لا نصوص مجمَّدة: الطابع وحده يُخزَّن، والعرض يُحسب وقت الرسم
            return Object.assign({}, s, { dueTimestamp: next, lastDoneTimestamp: Date.now() });
        }));
        // تسجيل التواصل أيضاً — إتمام التذكير تواصلٌ فعلي
        const sched = schedules.find((s) => s.id === id);
        if (sched) markContactNow(sched.groupId, sched.personId);
    }
    function addSchedule(groupId, personId, action, freqKey) {
        const key = freqKey || "weekly"; // ⛔ مُعرِّف لا نصّ
        setSchedules((prev) => [...prev, {
            id: `s-${Date.now()}`, groupId, personId, action, freqKey: key,
            dueTimestamp: Date.now() + scheduleFreqDays(key) * DAY_MS,
            lastDoneTimestamp: null,
        }]);
        showToast(t("sc_tm_hfz_almwad"), "success");
    }
    function updateSchedule(id, personId, action, freqKey) {
        setSchedules((prev) => prev.map((s) => {
            if (s.id !== id)
                return s;
            const key = freqKey || scheduleFreqKey(s);
            // تبديلُ التكرار يُعيد حساب الاستحقاق من آخر إنجازٍ أو من الآن
            const base = typeof s.lastDoneTimestamp === "number" ? s.lastDoneTimestamp : Date.now();
            return Object.assign({}, s, { personId, action, freqKey: key, dueTimestamp: base + scheduleFreqDays(key) * DAY_MS });
        }));
        showToast(t("sc_tm_tadyl_almwad"), "success");
    }
    function deleteSchedule(id) {
        setSchedules((prev) => prev.filter((s) => s.id !== id));
        showToast(t("sc_tm_hdhf_almwad"), "success");
    }
    function addEvent(groupId, personId, type, title, dateTimestamp, desc) {
        // ⛔ طابعٌ رقميّ لا نصّ منسَّق: يُفرز، ويُترجم عند الرسم، ويُقارَن
        const ts = typeof dateTimestamp === "number" ? dateTimestamp : Date.now();
        setEvents((prev) => [{ id: `e-${Date.now()}`, groupId, personId, type, title, desc: desc || "", dateTimestamp: ts }, ...prev]);
        // C75: حدث «وفاة» يُسجّل القريب متوفّى (كانت التذكيرات والمواعيد تستمرّ له)، و«مرض/عملية» تجعل حالته «مريض»
        const target = personId && (groupPersons[groupId] || []).find((p) => p.id === personId);
        if (target && type === "death" && target.alive !== false) {
            const d = new Date(ts), iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
            setGroupPersons((prev) => ({ ...prev, [groupId]: (prev[groupId] || []).map((p) => p.id === personId ? { ...p, alive: false, death_date: p.death_date || iso, status_detail: null } : p) }));
            setSchedules((prev) => prev.filter((sc) => sc.personId !== personId));
            showToast(tl("سُجّل " + target.local_name + (target.gender === "female" ? " متوفّاة — رحمها الله، وأُوقفت مواعيد التواصل معها" : " متوفّى — رحمه الله، وأُوقفت مواعيد التواصل معه"), target.local_name + " marked as deceased"), "info");
            return;
        }
        if (target && (type === "sickness" || type === "surgery") && target.alive !== false && !target.status_detail)
            setGroupPersons((prev) => ({ ...prev, [groupId]: (prev[groupId] || []).map((p) => p.id === personId ? { ...p, status_detail: "sick" } : p) }));
        showToast(t("fam_evt_added", { action: eventSuggestedActionLabel(type) }), "success");
    }
    function cycleMemberRole(groupId, userId) {
        const order = ["admin", "member", "viewer"];   // C33: المالك لا يُمنح بالتدوير — المالك واحد
        setMembers((prev) => ({
            ...prev,
            [groupId]: prev[groupId].map((m) => {
                if (m.userId !== userId || m.role === "owner")
                    return m;
                const next = order[(order.indexOf(m.role) + 1) % order.length];
                return { ...m, role: next };
            }),
        }));
    }
    function toggleGroupSetting(groupId, val) {
        setGroupSettings((prev) => ({ ...prev, [groupId]: { ...prev[groupId], allowMemberEvents: val } }));
    }
    const totalPersons = familyGroups.reduce((sum, g) => sum + (groupPersons[g.id] || []).length, 0);
    // ⛔ ترتيب أرحام: «اليوم» جذراً — من تأخّر تواصله، ميلادٌ، ذكرى، دعاء.
    // ومركز العائلة (الشجرة · الأفراد · المواعيد · المجموعات) على بُعد
    // زرٍّ في الشريط. التطبيق يفتح على أقاربك لا على إدارة بياناتهم.
    const rahimRootGroup = IS_RAHIM
        ? (familyGroups.find((g) => g.id === currentGroupId) || familyGroups[0] || null)
        : null;
    const discoverTop0 = discoverStack[discoverStack.length - 1]
        || (IS_RAHIM ? (rahimRootGroup ? { type: "suggestions", data: rahimRootGroup } : { type: "groups" }) : null);
    // C74: الشاشات تأخذ العائلة من المكدّس (نسخةٌ لحظة الفتح) ⇒ تغيّر الدور أو الاسم من السحابة لا يظهر حتّى تخرج وتعود.
    //      نستبدلها بالعائلة الحيّة من familyGroups لكلّ شاشات العائلة.
    const FAM_TOP_TYPES = ["groupDetail", "tree", "schedules", "members", "events", "stats", "suggestions", "activityLog"];
    const liveFam = discoverTop0 && FAM_TOP_TYPES.indexOf(discoverTop0.type) >= 0 && discoverTop0.data && discoverTop0.data.id
        ? familyGroups.find((g) => g.id === discoverTop0.data.id) : null;
    const discoverTop = liveFam && liveFam !== discoverTop0.data ? { ...discoverTop0, data: liveFam } : discoverTop0;
    let discoverContent;
    if (!discoverTop) {
        discoverContent = (React.createElement(DiscoverHomeScreen, { personCount: totalPersons, groupPersons: famPersons, onOpenFamily: () => setDiscoverStack([{ type: "groups" }]), onOpenMoments: () => { setMomentsReturnTab(null); setDiscoverStack([{ type: "moments" }]); }, onOpenErsal: () => setDiscoverStack([{ type: "ersal" }]), onOpenTaxi: () => setDiscoverStack([{ type: "taxi" }]), onOpenWallet: () => setStack(["wallet"]) }));
    }
    else if (discoverTop.type === "moments") {
        discoverContent = React.createElement(MomentsScreen, { posts: momentsPosts, myUserId: myUserId, onAddPost: addMomentPost, onToggleLike: toggleMomentLike, onAddComment: addMomentComment, onDeletePost: deleteMomentPost, onViewPost: viewMomentPost, onReplyPrivately: replyToMomentPrivately, onVotePoll: voteMomentPoll, onBack: () => { setDiscoverStack([]); if (momentsReturnTab) { const back = momentsReturnTab; setMomentsReturnTab(null); setTab(back); } } });
    }
    else if (discoverTop.type === "ersal") {
        discoverContent = (React.createElement(ErsalScreen, { shipments: shipments, onCreateShipment: createShipment, onMarkFailed: markShipmentFailed, onBulkCreateShipments: bulkCreateShipments, onChangeAddress: changeShipmentAddress, onConfirmPickup: confirmShipmentPickup, onSimulateDays: simulateShipmentDays, onCancelShipment: cancelShipment, onRateCourier: rateCourier, onReorderShipment: reorderShipment, onBack: () => setDiscoverStack([]) }));
    }
    else if (discoverTop.type === "taxi") {
        discoverContent = (React.createElement(TaxiScreen, { ride: taxiRide, tripsHistory: taxiTripsHistory, scheduledRides: scheduledTaxiRides, onRequestRide: requestTaxiRide, onScheduleRide: scheduleRide, onCancelScheduledRide: cancelScheduledRide, onTriggerScheduledRide: triggerScheduledRide, onCancelRide: cancelTaxiRide, onNewRide: () => setTaxiRide(null), onRateDriver: rateDriverTrip, onBack: () => setDiscoverStack([]) }));
    }
    else if (discoverTop.type === "groups") {
        discoverContent = (React.createElement(FamilyGroupsScreen, { groups: familyGroups, groupPersons: famPersons, currentGroupId: currentGroupId, onSetCurrent: setCurrentGroupId, proxEnabled: proxEnabled, onEnableProx: enableProx, onDisableProx: () => setProxEnabled(false), proxRadius: proxRadius, onSetProxRadius: (r) => { setProxRadius(r); try { localStorage.setItem(SAWA_STORE_PREFIX + "ui.proxRadius", JSON.stringify(r)); } catch (e) { } }, // ⛔ قائمة ← تفصيل ← رجوعٌ إلى القائمة. كان الاختيار يُفرغ المكدّس في
            // أرحام ظنّاً أنّه «تبديل»، فينقطع الطريق ويرجع السهم إلى الجذر.
            onOpenGroup: (g) => {
                if (IS_RAHIM)
                    setCurrentGroupId(g.id);
                setDiscoverStack([...discoverStack, { type: "groupDetail", data: g }]);
            },
            // سطر «ينتظر تواصلك» يفتح المجموعة مصفّاةً على المتأخّرين
            onOpenGroupOverdue: (g) => {
                if (IS_RAHIM)
                    setCurrentGroupId(g.id);
                setDiscoverStack([...discoverStack, { type: "groupDetail", data: g, filter: "overdue" }]);
            }, onCreateGroup: createFamilyGroup, onRenameGroup: renameFamilyGroup, onDeleteGroup: deleteFamilyGroup,
            // ⛔ السهم يتبع المكدّس لا العَلَم: هذه الشاشة جذرٌ في أرحام حين
            // لا مجموعة، ومدفوعةٌ حين تُفتح مبدّلاً — وإخفاؤه في الحالة
            // الثانية يحبس المستخدم فيها (الشريط السفلي يختفي عند الدفع).
            onBack: discoverStack.length ? () => setDiscoverStack(discoverStack.slice(0, -1)) : undefined }));
    }
    else if (discoverTop.type === "groupDetail") {
        const group = discoverTop.data;
        const otherGroups = familyGroups.filter((g) => g.id !== group.id).map((g) => ({ groupId: g.id, groupName: g.name, persons: famPersons[g.id] || [] }));
        discoverContent = (React.createElement(FamilyGroupDetailScreen, { meId: famMe[group.id] || (((famPersons[group.id] || []).find((p) => p.kinship === SELF_KINSHIP && p.kinStored !== SELF_KINSHIP)) || {}).id || null, onPickMe: (pid) => setFamMe((prev) => { const o = { ...(prev || {}) }; if (pid) o[group.id] = pid; else delete o[group.id]; return o; }), key: group.id + ":" + (discoverTop.filter || "all"), initialFilterStatus: discoverTop.filter || "all", group: group, persons: famPersons[group.id] || [], favorites: familyFavorites, otherGroups: otherGroups, onToggleFav: toggleFamilyFav, onOpenPerson: (p) => setDiscoverStack([...discoverStack, { type: "personDetail", data: p, groupId: group.id }]), onOpenGroups: IS_RAHIM ? () => setDiscoverStack(groupsStackFrom(discoverStack)) : undefined,
            // ⛔ الشاشة نفسها جذرٌ في أرحام ومحطّةٌ في سوا — السهم يتبع المكدّس
            onBack: discoverStack.length ? () => setDiscoverStack(discoverStack.slice(0, -1)) : undefined, onAddPerson: (data) => addPerson(group.id, data), onAddPersonChain: (chainNames, groupsOfRelatives, targetIndex, matchDecisions, firstGender, firstIsSelf) => addPersonChain(group.id, chainNames, groupsOfRelatives, targetIndex, matchDecisions, firstGender, firstIsSelf), onMergePersons: (keepId, removeId) => mergePersons(keepId, removeId), relations: kinshipRelations.filter((r) => r.groupId === group.id), onAddRelativesBulk: addRelativesBulk, onDeletePerson: (pid) => deletePerson(group.id, pid), onDeletePersonsBulk: (ids) => {
                const gid = group.id;
                const names = (groupPersons[gid] || []).filter((p) => ids.includes(p.id)).map((p) => p.local_name);
                // حذف واحد لكل الحالات — الاستدعاء المتتابع كان يقرأ حالة قديمة فيفشل
                setGroupPersons((prev) => ({ ...prev, [gid]: (prev[gid] || []).filter((p) => !ids.includes(p.id)) }));
                setKinshipRelations((prev) => prev.filter((r) => !(r.groupId === gid && (ids.includes(r.source) || ids.includes(r.target)))));
                setSchedules((prev) => prev.filter((s) => !(s.groupId === gid && ids.includes(s.personId))));
                setEvents((prev) => prev.filter((e) => !(e.groupId === gid && ids.includes(e.personId))));
                logActivity(gid, `حذفت ${ids.length} قريب (${names.slice(0, 3).join("، ")}${names.length > 3 ? "…" : ""})`);
                showToast(t("hdhf_qryb_walaqathm", { length: ids.length }), "success");
            }, groupAllowsMemberEvents: (_b = (_a = groupSettings[group.id]) === null || _a === void 0 ? void 0 : _a.allowMemberEvents) !== null && _b !== void 0 ? _b : false, onInferSpouses: () => inferSpousesAndParents(group.id), onRecalcProximity: () => {
                const gid = group.id;
                let n = 0;
                setGroupPersons((prev) => ({
                    ...prev,
                    [gid]: (prev[gid] || []).map((p) => {
                        const correct = proximityForKinship(p.kinship);
                        if (p.proximity === correct)
                            return p;
                        n++;
                        return { ...p, proximity: correct };
                    }),
                }));
                logActivity(gid, "واءمت درجات القرب مع صلات القرابة");
                showToast(t("wwymt_drjat_alqrb_ma"), "success");
            }, onMarkContactBulk: (ids) => {
                const now = Date.now();
                setGroupPersons((prev) => ({
                    ...prev,
                    [group.id]: (prev[group.id] || []).map((p) => ids.includes(p.id) ? { ...p, lastContactDate: now } : p),
                }));
                logActivity(group.id, t("sjlt_twasla_ma_qryb", { length: ids.length }));
                showToast(t("sjl_twaslk_ma_qryb", { length: ids.length }), "success");
            }, onExportSelected: (list) => {
                const { lineageLabel } = buildLineageHelpers(groupPersons[group.id] || [], kinshipRelations.filter((r) => r.groupId === group.id));
                const header = t("ai_aqarb") + group.name + "\n"
                    + t("ai_sddr_fy") + new Date().toLocaleString(loc()) + "\n"
                    + t("ai_aladad") + list.length + "\n" + "=".repeat(40) + "\n\n";
                const body = list.map((p, i) => {
                    var _a;
                    const days = daysSinceRef(p);
                    return (i + 1) + ". " + lineageLabel(p) + "\n"
                        + t("ai_alsla") + personKinLabel(p) + t("ai_alqrb") + (p.proximity || "—")
                        + (((_a = p.contacts) === null || _a === void 0 ? void 0 : _a.phone) ? " · " + p.contacts.phone : "")
                        + (p.alive
                            ? t("ai_akhr_twasl") + (days === Infinity ? t("ai_la_ywjd") : days + t("ai_ywm"))
                            : t("ai_mtwfa"));
                }).join("\n\n");
                saveTextFile("أقارب-" + group.name + ".txt", header + body);
                showToast(t("sdr", { count: list.length }), "success");
            }, onPrioritizeSelected: (ids) => {
                setGroupPersons((prev) => ({
                    ...prev,
                    [group.id]: (prev[group.id] || []).map((p) => ids.includes(p.id)
                        ? { ...p, proximity: { C: "B", B: "A", A: "A*", "A*": "A**", "A**": "A***", "A***": "A***" }[p.proximity] || "A*" }
                        : p),
                }));
                showToast(t("rfat_awlwya_altwasl_l", { count: ids.length }), "success");
            }, onSuggestForSelected: (list) => {
                const overdue = list.filter((p) => p.alive && isContactOverdue(p));
                if (overdue.length === 0) {
                    showToast(t("kl_almhddyn_twaslt_mahm"), "success");
                    return;
                }
                const top = overdue
                    .sort((a, b) => daysSinceRef(b) - daysSinceRef(a))
                    .slice(0, 3);
                showToast(t("alawla_baltwasl", { names: top.map((p) => p.local_name + " (" + daysSinceRef(p) + t("hrf_ywm") + ")").join(t("fasl_qayma")) }), "info");
            }, onOpenTree: () => setDiscoverStack([...discoverStack, { type: "tree", data: group }]), onOpenSuggestions: () => setDiscoverStack([...discoverStack, { type: "suggestions", data: group }]), onOpenSchedules: () => setDiscoverStack([...discoverStack, { type: "schedules", data: group }]), onOpenEvents: () => setDiscoverStack([...discoverStack, { type: "events", data: group }]), onOpenMembers: () => setDiscoverStack([...discoverStack, { type: "members", data: group }]) }));
    }
    else if (discoverTop.type === "personDetail") {
        const currentGroupIdForPerson = discoverTop.groupId;
        // نجيب النسخة الحديثة من الشخص من groupPersons بدل الاعتماد على
        // discoverTop.data (لقطة قديمة محفوظة وقت التنقّل لهذي الشاشة) — بدون
        // هذا، أي تعديل (خصوصاً توثيق الوفاة) ما كان ينعكس على نفس الشاشة فوراً
        const freshPerson = (famPersons[currentGroupIdForPerson] || []).find((p) => p.id === discoverTop.data.id) || discoverTop.data;
        const otherGroupsForPerson = familyGroups.filter((g) => g.id !== currentGroupIdForPerson).map((g) => ({ groupId: g.id, groupName: g.name, persons: groupPersons[g.id] || [] }));
        const linkedTo = freshPerson.linkedTo;
        const linkedGroupName = linkedTo ? (_c = familyGroups.find((g) => g.id === linkedTo.groupId)) === null || _c === void 0 ? void 0 : _c.name : null;
        const linkedPerson = linkedTo ? (groupPersons[linkedTo.groupId] || []).find((p) => p.id === linkedTo.personId) : null;
        const roleForPerson = (_d = familyGroups.find((g) => g.id === currentGroupIdForPerson)) === null || _d === void 0 ? void 0 : _d.role;
        const canEditPerson = roleForPerson !== "viewer";
        discoverContent = (React.createElement(FamilyPersonDetailScreen, { onChangeParent: canEditPerson ? (childId, g, pid) => changeParent(currentGroupIdForPerson, childId, g, pid) : null, person: freshPerson, persons: famPersons[currentGroupIdForPerson] || [], relations: kinshipRelations.filter((r) => r.groupId === currentGroupIdForPerson), favorites: familyFavorites, otherGroups: otherGroupsForPerson, linkedGroupName: linkedGroupName, linkedPersonName: linkedPerson === null || linkedPerson === void 0 ? void 0 : linkedPerson.local_name, canEdit: canEditPerson, onToggleFav: toggleFamilyFav, onEdit: (personId, data) => editPerson(currentGroupIdForPerson, personId, data), onDelete: (personId) => { deletePerson(currentGroupIdForPerson, personId); setDiscoverStack(discoverStack.slice(0, -1)); }, onOpenLinkedPerson: () => linkedTo && linkedPerson && setDiscoverStack([...discoverStack, { type: "personDetail", data: linkedPerson, groupId: linkedTo.groupId }]), onCreateInLaws: (p) => createInLawsGroup(discoverTop.groupId, p), onClearFacts: (pid) => {
                const gid = currentGroupIdForPerson;
                setGroupPersons((prev) => ({
                    ...prev,
                    [gid]: (prev[gid] || []).map((p) => p.id === pid ? { ...p, noChildren: false, neverMarried: false } : p),
                }));
                showToast(t("sysal_anh_fy_alaqtrahat"), "info");
            }, onSimulateProximity: (personId) => simulateProximity(personId, freshPerson.local_name), onMarkContact: (personId) => markContactNow(currentGroupIdForPerson, personId), onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    else if (discoverTop.type === "tree") {
        const canEditTree = famCanEdit(discoverTop.data);
        discoverContent = (React.createElement(FamilyTreeScreen, { groupId: discoverTop.data.id, persons: famPersons[discoverTop.data.id] || [], relations: kinshipRelations.filter((r) => r.groupId === discoverTop.data.id), canEdit: canEditTree, onAddRelation: addKinshipRelation, onChangeParent: changeParent, onClaimChildren: claimChildren, onDeleteRelation: deleteKinshipRelation, onEndMarriage: endMarriage, onOpenPerson: (p) => setDiscoverStack([...discoverStack, { type: "personDetail", data: p, groupId: discoverTop.data.id }]), onMarkContact: (personId) => markContactNow(discoverTop.data.id, personId), onQuickSchedule: (personId) => { setPreselectedSchedulePersonId(personId); setShowAddSchedule(true); }, onOpenStats: () => setDiscoverStack([...discoverStack, { type: "stats", data: discoverTop.data }]), onAddRelativeTo: (gid, person, relKey, kinship, gender) => setGapAddPreset({
                groupId: gid,
                relatedToId: person.id,
                relationType: relKey,
                // C75: ما يُخزَّن منسوبٌ لصاحب الشجرة دائماً (العرض يُحسب لكلّ مستخدم)
                presetKinship: kinPreview(groupPersons[gid] || [], kinshipRelations.filter((r) => r.groupId === gid), (groupPersons[gid] || []).find((x) => x.id === person.id), relKey, gender || "male") || kinship,
                presetGender: gender || null,
            }), onAddRelativesBulk: addRelativesBulk, allGroupPersons: famPersons, onInheritParents: () => inferSpousesAndParents(discoverTop.data.id, true), onOpenInLaws: (gid, person) => {
                var _a;
                if ((_a = person.linkedTo) === null || _a === void 0 ? void 0 : _a.groupId) {
                    // مرتبطة سلفاً — ننتقل لمجموعة أهلها
                    const g = familyGroups.find((x) => x.id === person.linkedTo.groupId);
                    if (g)
                        setDiscoverStack([{ type: "groups" }, { type: "groupDetail", data: g }]);
                    else
                        showToast(t("almjmwaa_almrtbta_ghyr_mwjwda"), "error");
                }
                else {
                    createInLawsGroup(gid, person);
                }
            }, onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    else if (discoverTop.type === "stats") {
        discoverContent = (React.createElement(FamilyStatsScreen, { persons: famPersons[discoverTop.data.id] || [], relations: kinshipRelations.filter((r) => r.groupId === discoverTop.data.id), onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    else if (discoverTop.type === "suggestions") {
        discoverContent = (React.createElement(FamilySuggestionsScreen, { // ⛔ أثرٌ كامل لا قفزة: قرار خالد أن يقود السهم من مركز العائلة إلى
            // قائمة العوائل دائماً. ويتحقّق باصطناع الأثر لا باستثناءٍ في السهم.
            onOpenFamily: IS_RAHIM ? () => setDiscoverStack([{ type: "groups" }, { type: "groupDetail", data: discoverTop.data }]) : undefined,
            // ⛔ بلا relatedToId لا تُنشأ صلة — والنموذج يفتح على «نفسي»
            onStartSelf: () => setGapAddPreset({ groupId: discoverTop.data.id, relatedToId: null, relationType: null, presetKinship: SELF_KINSHIP }), groupId: discoverTop.data.id, persons: famPersons[discoverTop.data.id] || [], relations: kinshipRelations, events: events, dismissed: dismissedSuggestions, onDismiss: (id) => setDismissedSuggestions((prev) => ({ ...prev, [id]: true })), onExecute: (id) => setDismissedSuggestions((prev) => ({ ...prev, [id]: true })), onQuickStatus: (personId, statusValue) => quickUpdateStatus(discoverTop.data.id, personId, statusValue), onConfirmNone: (personId, kind) => {
                var _a;
                const gid = discoverTop.data.id;
                const nm = ((_a = (groupPersons[gid] || []).find((p) => p.id === personId)) === null || _a === void 0 ? void 0 : _a.local_name) || t("ai_alqryb");
                // حقيقة مؤكَّدة لا تجاهل مؤقت — لن يعود السؤال
                setGroupPersons((prev) => ({
                    ...prev,
                    [gid]: (prev[gid] || []).map((p) => p.id === personId
                        ? { ...p, ...(kind === "children" ? { noChildren: true } : { neverMarried: true }) }
                        : p),
                }));
                logActivity(gid, kind === "children" ? t("sjlt_an_bla_abna", { nm }) : t("sjlt_an_lm_ytzwj", { nm }));
                showToast(t("sjlt_almalwma"), "success");
            }, onSetAlive: (personId, alive) => {
                var _a;
                const gid = discoverTop.data.id;
                const nm = ((_a = (groupPersons[gid] || []).find((p) => p.id === personId)) === null || _a === void 0 ? void 0 : _a.local_name) || t("ai_alqryb");
                setGroupPersons((prev) => ({
                    ...prev,
                    [gid]: (prev[gid] || []).map((p) => p.id === personId ? { ...p, alive, status_detail: alive ? p.status_detail : null } : p),
                }));
                logActivity(gid, alive ? t("akdt_an_ala_qyd", { nm }) : t("sjlt_wfaa", { nm }));
                showToast(alive ? t("ai_sjjl") : t("rhm_allh", { nm }), alive ? "success" : "info");
            }, // ⛔ جنس الوالد يُمرَّر: «من والده؟» تفتح النموذج على ذكر، و«والدته» على أنثى
            onOpenAddWithPreset: (relatedToId, relationType, parentGender) => setGapAddPreset({
                groupId: discoverTop.data.id, relatedToId, relationType,
                presetKinship: parentGender
                    ? deriveKinship(((groupPersons[discoverTop.data.id] || []).find((x) => x.id === relatedToId) || {}).kinship, "parent", parentGender) // ⛔ اشتقاق لا عرض
                    : undefined,
            }), onOpenBulkAdd: (person, kind) => person && setBulkAddPreset({
                groupId: discoverTop.data.id,
                person,
                // نفتح الشيت على أول خيار مناسب: أبناء للأبناء، زوجات للزواج
                startRel: kind === "marriage" ? "spouse" : "child",
            }), onBack: discoverStack.length ? () => setDiscoverStack(discoverStack.slice(0, -1)) : undefined }));
    }
    else if (discoverTop.type === "schedules") {
        discoverContent = (React.createElement(FamilySchedulesScreen, { groupId: discoverTop.data.id, schedules: schedules, persons: famPersons[discoverTop.data.id] || [], canAdd: discoverTop.data.role === "owner" || discoverTop.data.role === "admin", onComplete: completeSchedule, onAdd: () => { setEditingSchedule(null); setShowAddSchedule(true); }, onEdit: (sch) => { setEditingSchedule(sch); setShowAddSchedule(true); }, onDelete: deleteSchedule, onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    else if (discoverTop.type === "events") {
        const group = discoverTop.data;
        const canAddEvent = group.role === "owner" || group.role === "admin" || ((_f = groupSettings[group.id]) === null || _f === void 0 ? void 0 : _f.allowMemberEvents);
        discoverContent = React.createElement(FamilyEventsScreen, { groupId: group.id, events: events, persons: famPersons[group.id] || [], canAdd: canAddEvent, onAdd: () => { setEditingEvent(null); setShowAddEvent(true); }, onEdit: (ev) => { setEditingEvent(ev); setShowAddEvent(true); }, onDelete: deleteEvent, onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) });
    }
    else if (discoverTop.type === "members") {
        const group = discoverTop.data;
        const SS = window.SawaSync, cloud = !!(SS && SS.isCloud && SS.isCloud(group.id));
        discoverContent = (React.createElement(FamilyMembersScreen, { groupId: group.id, members: members, canManage: group.role === "owner", canInvite: group.role === "owner" || group.role === "admin", cloud: cloud, settings: groupSettings,
            onCycleRole: cloud ? (gid, uid) => SS.cycleMemberRole(gid, uid) : cycleMemberRole,
            onToggleSetting: cloud ? (gid, val) => { toggleGroupSetting(gid, val); SS.setAllowMemberEvents(gid, val); } : toggleGroupSetting,
            onRemove: cloud ? (gid, uid) => SS.removeMember(gid, uid) : null,
            onShare: cloud ? (role) => SS.shareLink(role, group.id) : null, onOpenActivityLog: () => setDiscoverStack([...discoverStack, { type: "activityLog", data: group }]), onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    else if (discoverTop.type === "activityLog") {
        discoverContent = (React.createElement(FamilyActivityLogScreen, { groupId: discoverTop.data.id, activityLog: activityLog, onBack: () => setDiscoverStack(discoverStack.slice(0, -1)) }));
    }
    return (React.createElement(PhoneFrame, { dir: interfaceLanguage === "en" ? "ltr" : "rtl" },
        flow === "onboarding" && React.createElement(OnboardingScreen, { onDone: () => setFlow("setup") }),
        flow === "setup" && (React.createElement(SetupPinScreen, { onDone: (newPin, newCodes) => {
                setPin(newPin);
                setRecoveryCodes(newCodes);
                setFlow(backendLinked || backendSkipped ? "app" : "connectBackend");
            } })),
        flow === "connectBackend" && (React.createElement(ConnectBackendScreen, { onDone: () => { setBackendLinked(true); setFlow("app"); }, onSkip: () => { setBackendSkipped(true); setFlow("app"); } })),
        flow === "locked" && (React.createElement(LockScreen, { correctPin: pin, biometricEnabled: biometricEnabled, onUnlock: () => setFlow("app"), onForgot: () => setFlow("forgot") })),
        flow === "forgot" && (React.createElement(ForgotPinScreen, { validCodes: recoveryCodes, onBack: () => setFlow("locked"), onRecovered: (newPin, newCodes, wipe) => {
                if (wipe) {
                    setPin(null);
                    setNotes([]);
                    setFlow("setup");
                    return;
                }
                setPin(newPin);
                setRecoveryCodes(newCodes);
                setFlow("postRecoveryCodes");
            } })),
        flow === "postRecoveryCodes" && (React.createElement(PostRecoveryCodesScreen, { codes: recoveryCodes, onDone: () => setFlow("app") })),
        flow === "app" && proxAlert && React.createElement(ProximitySheet, { alert: proxAlert, onClose: () => setProxAlert(null),
            onVisit: () => { markContactNow(proxAlert.gid, proxAlert.person.id); logActivity(proxAlert.gid, tl("زيارة " + proxAlert.person.local_name, "Visited " + proxAlert.person.local_name)); setProxAlert(null); },
            onCall: (phone) => { const a = proxAlert; setProxAlert(null); markContactNow(a.gid, a.person.id); if (phone) { try { location.href = "tel:" + phone.replace(/[^\d+]/g, ""); } catch (e) { } } else showToast(tl("لا رقم مسجَّلاً له — أضفه من ملفّه", "No phone saved — add it in their profile"), "error"); },
            onSnooze: () => { proxSeenSet(proxAlert.person.id, new Date(Date.now() + 7200000).toISOString()); setProxAlert(null); showToast(tl("سأذكّرك بعد ساعتين", "I'll remind you in 2 hours"), "success"); },
            onMute: () => { try { const m = JSON.parse(localStorage.getItem("sawa_prox_mute") || "{}"); m[proxAlert.person.id] = 1; localStorage.setItem("sawa_prox_mute", JSON.stringify(m)); } catch (e) { } setProxAlert(null); },
            onOpenPerson: () => { const a = proxAlert; setProxAlert(null); const g = familyGroups.find((x) => x.id === a.gid); if (!g) return; setTab("discover"); setDiscoverStack([{ type: "groups" }, { type: "groupDetail", data: g }, { type: "personDetail", data: a.person, groupId: a.gid }]); } }),
        flow === "app" && homeSave && React.createElement(HomePickerSheet, { coords: homeSave, label: homeSave.label, groups: familyGroups, groupPersons: groupPersons, onClose: () => setHomeSave(null), onPick: (gid, p) => { setPersonHome(gid, p, homeSave, homeSave.label); setHomeSave(null); } }),
        flow === "app" && activeRoom && (React.createElement(ErrorBoundary, null,
            React.createElement(SawaRoomScreen, { roomCode: activeRoom, onBack: () => setActiveRoom(null), familyMembers: Object.values(groupPersons).flat().filter((p) => { var _a; return p.alive && ((_a = p.contacts) === null || _a === void 0 ? void 0 : _a.phone); }), groups: groups, onSendTasksToGroup: (groupId, title, texts) => {
                    const g = groups.find((x) => x.id === groupId);
                    createGroupTaskList(groupId, title, texts.map((txt) => {
                        var _a, _b;
                        return ({
                            text: t, assigneeId: (_b = (_a = g === null || g === void 0 ? void 0 : g.members) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id, dueAt: "",
                        });
                    }));
                }, onInviteFamily: (members, link) => {
                    const now = Date.now();
                    // أرسل الرابط لكل فرد لديه محادثة، وسجّل التواصل في صلة الرحم
                    setConversations((prev) => prev.map((cv) => {
                        const hit = members.find((m) => {
                            var _a;
                            return cv.name && ((_a = m.local_name) === null || _a === void 0 ? void 0 : _a.split(" ")[0]) &&
                                cv.name.toLowerCase().includes(m.local_name.split(" ")[0].toLowerCase());
                        });
                        return hit ? { ...cv, lastMessage: "🎥 دعوة لغرفة سوا: " + link, updatedAt: now } : cv;
                    }));
                    const ids = members.map((m) => m.id);
                    setGroupPersons((prev) => {
                        const up = { ...prev };
                        Object.keys(up).forEach((g) => {
                            up[g] = up[g].map((p) => ids.includes(p.id) ? { ...p, lastContactDate: now } : p);
                        });
                        return up;
                    });
                } }))),
        flow === "app" && showLinkedDevices && (React.createElement(LinkedDevicesScreen, { onBack: () => setShowLinkedDevices(false) })),
        flow === "app" && showWrapped && (React.createElement(SawaWrappedScreen, { onBack: () => setShowWrapped(false), conversations: conversations, groups: groups, showToast: showToast })),
        flow === "app" && showFeedback && (React.createElement(FeedbackSheet, { onClose: () => setShowFeedback(false), currentScreen: tab })),
        flow === "app" && dailyCard && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setDailyCard(null), style: { position: "fixed", inset: 0, zIndex: 60, backgroundColor: "rgba(0,0,0,0.45)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 16, right: 16, top: "50%", transform: "translateY(-50%)", zIndex: 61, backgroundColor: colors.card, borderRadius: 22, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.3)" } },
                React.createElement("div", { className: "px-5 pt-5 pb-3 text-center", style: { backgroundColor: colors.primaryLight } },
                    React.createElement("div", { className: "text-2xl mb-1" }, "\uD83E\uDD0D"),
                    React.createElement("div", { className: "text-sm font-extrabold", style: { color: colors.primaryDark } }, t("dr_title")),
                    React.createElement("div", { className: "text-[10px] mt-0.5", style: { color: colors.primary } }, t("dr_sub"))),
                React.createElement("div", { className: "px-5 py-5 text-center" },
                    React.createElement("div", { className: "inline-block rounded-full px-2.5 py-0.5 mb-3 text-[10px] font-bold", style: { backgroundColor: colors.bg, color: colors.textMuted } }, dailyCard.kind),
                    React.createElement("p", { className: "text-base leading-loose font-bold", style: { color: colors.text } }, dailyCard.text),
                    dailyCard.source && React.createElement("p", { className: "text-[11px] mt-3", style: { color: colors.textMuted } }, dailyCard.source)),
                React.createElement("div", { className: "flex flex-row border-t", style: { borderColor: colors.border } },
                    React.createElement("button", { onClick: () => { setDailyCard(null); setTab("discover"); setDiscoverStack([{ type: "groups" }]); }, className: "flex-1 py-3.5 border-l", style: { borderColor: colors.border } },
                        React.createElement("span", { className: "text-sm font-extrabold", style: { color: colors.primary } }, t("sla_alrhm"))),
                    React.createElement("button", { onClick: () => setDailyCard(null), className: "flex-1 py-3.5" },
                        React.createElement("span", { className: "text-sm font-bold", style: { color: colors.textMuted } }, t("ighlaq"))))))),
        flow === "app" && !activeRoom && !showLinkedDevices && !showWrapped && (React.createElement("div", { className: "flex-1 flex flex-col overflow-hidden" },
        showHelp && React.createElement("div", { className: "absolute inset-0 z-50 flex flex-col", style: { backgroundColor: "white" } }, React.createElement(HelpScreen, { onBack: function(){setShowHelp(false);}, onRestartTour: function(){resetTooltips();setShowHelp(false);} })),
        isDemoMode && React.createElement("div", { className: "flex items-center justify-between px-3 py-1.5", style: { backgroundColor: "#F59E0B", flexShrink: 0 } }, React.createElement("span", { className: "text-[10px] font-bold text-white" }, "⚠️ عرض توضيحي — البيانات وهمية"), React.createElement("button", { onClick: function(){ setFamilyGroups([{id:"g-main",name:"عائلتي",description:"",role:"owner",ownerPersonId:null}]); setGroupPersons({"g-main":[]}); setIsDemoMode(false); }, className: "text-[10px] font-extrabold text-white underline" }, "ابدأ من صفر")),
            React.createElement("div", { className: "flex-1 overflow-hidden flex flex-col" }, stack[stack.length - 1] === "security" ? (React.createElement(ProfileSettingsScreen, { onBack: () => setStack([]), onChangePin: () => setFlow("setup"), biometricEnabled: biometricEnabled, setBiometricEnabled: setBiometricEnabled, autoLockDelay: autoLockDelay, setAutoLockDelay: setAutoLockDelay, remainingCodes: recoveryCodes.length, onLockNow: () => setFlow("locked"), onOpenSessions: () => setStack(["security", "sessions"]), profilePhoto: profilePhoto, setProfilePhoto: setProfilePhoto, interfaceLanguage: interfaceLanguage, setInterfaceLanguage: setInterfaceLanguage, pinLockEnabled: pinLockEnabled, setPinLockEnabled: setPinLockEnabled, browserNotifEnabled: browserNotifEnabled, onToggleBrowserNotif: toggleBrowserNotif, statusOption: statusOption, setStatusOption: setStatusOption, customStatusMessage: customStatusMessage, setCustomStatusMessage: setCustomStatusMessage, redeemedReferralCode: redeemedReferralCode, onRedeemReferral: redeemReferral, blockUnsolicited: blockUnsolicited, setBlockUnsolicited: setBlockUnsolicited, identityVerified: identityVerified, chatBackupEnabled: chatBackupEnabled, setChatBackupEnabled: setChatBackupEnabled, onDeleteKeys: deleteEncryptionKeys, backendLinked: backendLinked, onUnlink: () => setBackendLinked(false) })) : stack[stack.length - 1] === "sessions" ? (React.createElement(SessionsScreen, { sessions: sessions, onRevoke: revokeSession, onRevokeAll: revokeAllSessions, onBack: () => setStack(["security"]) })) : stack[0] === "wallet" && !walletUnlocked ? (React.createElement(WalletLockScreen, { onUnlock: () => setWalletUnlocked(true), onBack: () => setStack([]), walletPasskeyId: walletPasskeyId, onPasskeyRegistered: setWalletPasskeyId, walletPin: walletPin, onSetWalletPin: setWalletPin })) : stack[0] === "wallet" && walletUnlocked ? (React.createElement(WalletScreen, { balance: walletBalance, transactions: walletTransactions, cardNumber: walletCardNumber, walletPinForConfirm: walletPin, kycStatus: kycStatus, kycDismissed: kycDismissed, onDismissKyc: () => setKycDismissed(true), onSubmitKyc: submitKyc, onTopUp: topUpWallet, onTransfer: transferWallet, onScanPay: scanPay, onBack: () => { setStack([]); setWalletUnlocked(false); }, linkedMethods: linkedPaymentMethods, onAddPaymentMethod: addPaymentMethod, onRemovePaymentMethod: removePaymentMethod, spendingLimit: spendingLimit, onSetSpendingLimit: setSpendingLimit, jamiyaList: jamiyaList, onPayJamiya: payJamiya, onCreateJamiya: createJamiya, CURRENT_USER_ID: CURRENT_USER_ID })) : stack[0] === "stats" ? (React.createElement(StatsScreen, { transactions: walletTransactions, onBack: () => setStack([]) })) : stack[0] === "notifications" ? (React.createElement(NotificationCenterScreen, { notifications: notifications, onMarkRead: markNotificationRead, onBack: () => setStack([]) })) : stack[stack.length - 1] === "demo" ? (React.createElement(EncryptedNotesDemoScreen, { onBack: () => setStack([]), notes: notes, onAdd: (text) => setNotes((prev) => [{ id: Date.now(), text }, ...prev]), onDelete: (id) => setNotes((prev) => prev.filter((n) => n.id !== id)) })) : (React.createElement(React.Fragment, null,
                tab === "chats" && (() => {
                    const chatsTop = chatsStack[chatsStack.length - 1];
                    if (!backendLinked) {
                        return React.createElement(PlaceholderTab, { icon: CloudOff, title: t("almhadthat"), note: "\u0627\u0631\u0628\u0637 \u062D\u0633\u0627\u0628\u0643 \u0628\u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u0645\u0646 \u0634\u0627\u0634\u0629 \u062D\u0633\u0627\u0628\u064A \u0644\u062A\u062A\u0645\u0643\u0651\u0646 \u0645\u0646 \u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0627\u0644\u0645\u062D\u0627\u062F\u062B\u0627\u062A" });
                    }
                    if (!chatsTop) {
                        return (React.createElement(ConversationsListScreen, { onOpenFamilyPerson: (p) => { const gid = Object.keys(groupPersons).find((k) => (groupPersons[k] || []).some((x) => x.id === p.id)); const g = familyGroups.find((x) => x.id === gid); if (!g) return; setTab("discover"); setDiscoverStack([{ type: "groups" }, { type: "groupDetail", data: g }, { type: "personDetail", data: p, groupId: gid }]); }, chatDrafts: chatDrafts, conversations: conversations, groups: groups, broadcastLists: broadcastLists, lockedConversationIds: lockedConversationIds, connectionState: "connected", onOpenChat: (c) => { setChatsStack([{ type: "chat", data: Object.assign({}, c, { unreadOnOpen: c.unread || 0 }) }]); markConversationRead(c.id); }, onOpenGroup: (g) => { setChatsStack([{ type: "group", data: Object.assign({}, g, { unreadOnOpen: g.unread || 0 }) }]); markGroupRead(g.id); }, onOpenBroadcastList: (b) => setChatsStack([{ type: "broadcast", data: b }]), onNewConversation: () => setChatsStack([{ type: "new" }]), onNewGroup: () => setChatsStack([{ type: "newGroup" }]), onNewBroadcastList: () => setChatsStack([{ type: "newBroadcast" }]), onOpenLockedChats: () => setChatsStack([{ type: "lockedChats" }]), onOpenStarredMessages: () => setChatsStack([{ type: "starredMessages" }]), onlineContacts: onlineContacts, onScanQr: scanQrContact, onOpenSearch: () => setChatsStack([{ type: "search" }]), chatFolders: chatFolders, folderAssignments: folderAssignments, onOpenChatSettings: () => setChatsStack([{ type: "chatSettings" }]), typingConversations: typingConversations, momentsPosts: momentsPosts, familyPersons: Object.values(famPersons).flat(), onOpenMoments: () => { setMomentsReturnTab("chats"); setTab("discover"); setDiscoverStack([{ type: "moments" }]); }, onOpenRoom: () => { if (!((window.SawaRTC && window.SawaRTC.enabled && window.SawaRTC.enabled()) && window.SawaRTC.roomCreate())) setActiveRoom(generateRoomCode()); }, onJoinRoomCode: () => { if (!((window.SawaRTC && window.SawaRTC.enabled && window.SawaRTC.enabled()) && window.SawaRTC.roomJoinPrompt())) showToast("سجّل الدخول أوّلاً للانضمام إلى غرفة", "info"); }, onScheduleRoom: () => setSchedulingRoom(true), onOpenScheduledRooms: () => setRoomsListOpen(true), scheduledRooms: scheduledRooms, onJoinScheduled: (code) => { if (!((window.SawaRTC && window.SawaRTC.enabled && window.SawaRTC.enabled()) && window.SawaRTC.roomJoin(code))) setActiveRoom(code); }, onCancelScheduled: (id) => { const sr = scheduledRooms.find((r) => r.id === id); if (sr && sr.cloud && window.SawaRTC) window.SawaRTC.schedRemove(id); else setScheduledRooms((p) => p.filter((r) => r.id !== id)); showToast(t("alghy_almwad"), "info"); }, myName: t("ai_ana"), groupPersons: famPersons, groupSchedules: groupSchedules, showStoriesRow: showStoriesRow, showFamilyReminders: showFamilyReminders, onOpenArchived: () => setChatsStack([{ type: "archived" }]), pinnedConversations: pinnedConversations, onPinConv: (id) => {
                                setPinnedConversations((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
                                showToast(pinnedConversations.includes(id) ? t("ai_ilgha_altthbyt") : t("ai_tm_altthbyt"), "success");
                            }, onToggleReadConv: (id) => {
                                setConversations((prev) => prev.map((c) => c.id === id ? { ...c, unread: c.unread > 0 ? 0 : 1 } : c));
                            }, onDeleteConv: (id) => {
                                if (cloudChat(id)) { cloudChat(id).clearChat(id); showToast(t("hdhft_almhadtha"), "success"); return; }
                                setConversations((prev) => prev.filter((c) => c.id !== id));
                                setMessagesByConversation((prev) => { const n = { ...prev }; delete n[id]; return n; });
                                setPinnedConversations((p) => p.filter((x) => x !== id));
                                setArchivedConversations((p) => p.filter((x) => x !== id));
                                showToast(t("hdhft_almhadtha"), "success");
                            }, archivedConversations: archivedConversations, mutedConversations: mutedConversations, onArchiveConv: handleArchiveConv, onMuteConv: handleMuteConv }));
                    }
                    if (chatsTop.type === "archived") {
                        return (React.createElement(ArchivedChatsScreen, { conversations: conversations, archivedIds: archivedConversations, mutedIds: mutedConversations, onOpenChat: (cv) => setChatsStack([{ type: "chat", data: cv }]), onUnarchive: (id) => {
                                setArchivedConversations((p) => p.filter((x) => x !== id));
                                showToast(t("tmt_alastaada"), "success");
                            }, onBack: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "lockedChats") {
                        return (React.createElement(LockedChatsScreen, { conversations: conversations, lockedConversationIds: lockedConversationIds, correctPin: pin, onOpenChat: (c) => setChatsStack([{ type: "chat", data: c }]), onClose: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "starredMessages") {
                        return (React.createElement(StarredMessagesScreen, { starredMessages: starredMessages, onOpenConversation: (conversationId) => {
                                const conv = conversations.find((c) => c.id === conversationId);
                                if (conv)
                                    setChatsStack([{ type: "chat", data: conv }]);
                            }, onBack: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "chatSettings") {
                        return (React.createElement(ChatSettingsScreen, { chatBackupEnabled: chatBackupEnabled, setChatBackupEnabled: setChatBackupEnabled, chatFolders: chatFolders, onAddFolder: addChatFolder, onDeleteFolder: deleteChatFolder, defaultNotificationTone: defaultNotificationTone, setDefaultNotificationTone: setDefaultNotificationTone, lockedCount: lockedConversationIds.length, onOpenLockedChats: () => setChatsStack([{ type: "lockedChats" }]), showStoriesRow: showStoriesRow, setShowStoriesRow: setShowStoriesRow, showFamilyReminders: showFamilyReminders, setShowFamilyReminders: setShowFamilyReminders, onBack: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "newBroadcast") {
                        return (React.createElement(NewBroadcastListScreen, { conversations: conversations, onCreate: (name, recipientIds) => createBroadcastList(name, recipientIds), onClose: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "broadcast") {
                        const liveList = broadcastLists.find((b) => b.id === chatsTop.data.id) || chatsTop.data;
                        return (React.createElement(BroadcastListScreen, { list: liveList, conversations: conversations, myUserId: myUserId, onSend: (text) => sendBroadcastMessage(liveList.id, text), onBack: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "group") {
                        const liveGroup = groups.find((g) => g.id === chatsTop.data.id) || chatsTop.data;
                        return (React.createElement(GroupChatScreen, { group: liveGroup, messages: groupMessages[liveGroup.id] || [], myUserId: myUserId, draft: chatDrafts["g:" + liveGroup.id] || "", onSaveDraft: (v) => saveChatDraft("g:" + liveGroup.id, v), onTyping: () => { const c = cloudChat(liveGroup.id); if (c) c.typing(liveGroup.id); }, onSendSticker: (emoji) => sendGroupSticker(liveGroup.id, emoji), contactsForForward: (window.SawaChat && window.SawaChat.contacts ? window.SawaChat.contacts() : []), unreadCount: chatsTop.data.unreadOnOpen || 0, onSend: (text, replyTo) => sendGroupMessage(liveGroup.id, text, replyTo),
                            onReact: cloudChat(liveGroup.id) ? (messageId, emoji) => cloudChat(liveGroup.id).react(liveGroup.id, messageId, emoji) : null,
                            onDeleteMessage: cloudChat(liveGroup.id) ? (messageId, scope) => { scope === "all" ? cloudChat(liveGroup.id).deleteForAll(liveGroup.id, messageId) : cloudChat(liveGroup.id).deleteForMe(liveGroup.id, messageId); showToast(scope === "all" ? t("ai_hdhft_lljmya") : t("ai_hdhft_andk"), "success"); } : null,
                            contacts: cloudChat(liveGroup.id) ? people : null,
                            onInviteLink: cloudChat(liveGroup.id) ? (gid) => cloudChat(gid).shareGroupInvite(gid) : null,
                            onUpdateGroup: cloudChat(liveGroup.id) ? (gid, patch) => cloudChat(gid).updateGroup(gid, patch) : null, onSendFile: (name, size, fileUrl, type, file) => sendGroupFile(liveGroup.id, name, size, fileUrl, type, file), onSendVoice: (url, duration, transcript, blob, secs) => sendGroupVoice(liveGroup.id, url, duration, transcript, blob, secs), onEditMessage: (messageId, newText) => editGroupMessage(liveGroup.id, messageId, newText), onCreatePoll: (q, opts, deadlineMinutes, anonymous) => createGroupPoll(liveGroup.id, q, opts, deadlineMinutes, anonymous), onEditPoll: (pollId, q, opts) => editGroupPoll(liveGroup.id, pollId, q, opts), onVotePoll: (pollId, optIdx) => voteGroupPoll(liveGroup.id, pollId, optIdx), onCreateBillSplit: (desc, total, participantAmounts, splitType) => createGroupBillSplit(liveGroup.id, desc, total, participantAmounts, splitType), onPayBillSplit: (billId) => payGroupBillSplit(liveGroup.id, billId), onCreateFundraiser: (cause, goal, deadline) => createGroupFundraiser(liveGroup.id, cause, goal, deadline), onContributeFundraiser: (fundraiserId) => contributeGroupFundraiser(liveGroup.id, fundraiserId), onCreateTaskList: (title, drafts) => createGroupTaskList(liveGroup.id, title, drafts), onToggleTaskStatus: (listId, taskId) => toggleGroupTaskStatus(liveGroup.id, listId, taskId), onAddTaskNote: (listId, taskId, note) => addGroupTaskNote(liveGroup.id, listId, taskId, note), onForward: (text, destinationIds) => forwardMessageToTargets(text, destinationIds), allConversations: conversations, allGroups: groups, onRenameGroup: renameGroup, onAddGroupMembers: addGroupMembers, onRemoveGroupMember: removeGroupMember, onToggleGroupAdmin: toggleGroupAdmin, onLeaveGroup: leaveGroup, onBack: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "newGroup") {
                        return React.createElement(NewGroupScreen, { onCreate: createGroup, onClose: () => setChatsStack([]), contacts: (function () {
                            // C3: على السحابة جهات الاتّصال الحقيقيّة فقط
                            if (window.SawaChat && window.SawaChat.enabled && window.SawaChat.enabled()) return people.map((p) => ({ name: p.name, source: (p.families && p.families[0] && p.families[0].name) || "" }));
                            const seen = {}; const out = [];
                            conversations.forEach(function (c) { if (c.isSavedMessages || !c.name || seen[c.name]) return; seen[c.name] = 1; out.push({ name: c.name, source: t("ai_mhadthaty") }); });
                            Object.values(groupPersons).flat().forEach(function (p) { const nm = p.local_name; if (!nm || seen[nm]) return; seen[nm] = 1; out.push({ name: nm, source: t("ai_sla_alrhm") }); });
                            return out;
                        })() });
                    }
                    if (chatsTop.type === "chat") {
                        const convMessages = messagesByConversation[chatsTop.data.id] || [];
                        // المحادثة الحيّة (الاسم/التثبيت/الاختفاء من الخادم) لا لقطة لحظة الفتح
                        const liveConv = conversations.find((c) => c.id === chatsTop.data.id) || chatsTop.data;
                        const SCc = cloudChat(chatsTop.data.id);
                        return (React.createElement(ChatScreen, { conversation: liveConv, messages: convMessages, draft: chatDrafts[chatsTop.data.id] || "", onSaveDraft: (v) => saveChatDraft(chatsTop.data.id, v), onTyping: () => { const c = cloudChat(chatsTop.data.id); if (c) c.typing(chatsTop.data.id); }, contactsForForward: (window.SawaChat && window.SawaChat.contacts ? window.SawaChat.contacts() : []), unreadCount: chatsTop.data.unreadOnOpen || 0, onSend: (text, replyTo) => sendChatMessage(chatsTop.data.id, text, replyTo), onForward: (text, destinationIds) => forwardMessageToTargets(text, destinationIds), onTogglePin: (messageId) => togglePinMessage(chatsTop.data.id, messageId), onToggleStar: (messageId, text) => toggleStarMessage(chatsTop.data.id, messageId, text), isTyping: typingConversations.includes(chatsTop.data.id), onLogCall: logCall, isOnline: liveConv.cloud ? !!liveConv.online : onlineContacts.includes(chatsTop.data.name), callSettings: callSettings, allConversations: conversations, allGroups: groups, onReact: (messageId, emoji) => reactToChatMessage(chatsTop.data.id, messageId, emoji), onSendSticker: (emoji) => sendChatSticker(chatsTop.data.id, emoji), onSendFile: (name, size, fileUrl, type, viewOnce, file) => sendChatFile(chatsTop.data.id, name, size, fileUrl, type, viewOnce, file), onSendVoice: (url, duration, transcript, blob, secs) => sendChatVoice(chatsTop.data.id, url, duration, transcript, blob, secs), onMarkViewedOnce: (messageId) => markMessageViewedOnce(chatsTop.data.id, messageId), onEditMessage: (messageId, newText) => editChatMessage(chatsTop.data.id, messageId, newText), onDeleteMessage: (messageId, scope) => {
                                if (SCc) { scope === "all" ? SCc.deleteForAll(chatsTop.data.id, messageId) : SCc.deleteForMe(chatsTop.data.id, messageId); showToast(scope === "all" ? t("ai_hdhft_lljmya") : t("ai_hdhft_andk"), "success"); return; }
                                // تحرير رابط الوسائط المؤقّت — بدونه يبقى الملف
                                // في ذاكرة المتصفح بعد حذف الرسالة
                                try {
                                    const gone = (messagesByConversation[chatsTop.data.id] || []).find((m) => m.id === messageId);
                                    if (gone && gone.fileUrl && String(gone.fileUrl).indexOf("blob:") === 0) URL.revokeObjectURL(gone.fileUrl);
                                } catch (e) { }
                                setMessagesByConversation((prev) => ({
                                    ...prev,
                                    [chatsTop.data.id]: (prev[chatsTop.data.id] || []).map((m) => m.id === messageId
                                        ? (scope === "all"
                                            ? { ...m, text: "🚫 حُذفت هذه الرسالة", type: "text", deleted: true, fileUrl: null }
                                            : null)
                                        : m).filter(Boolean),
                                }));
                                // تحديث سطر «آخر رسالة» في القائمة. بدونه يبقى
                                // نص الرسالة المحذوفة ظاهراً في قائمة المحادثات.
                                setConversations((prev) => prev.map((c) => {
                                    if (c.id !== chatsTop.data.id) return c;
                                    const after = ((messagesByConversation[chatsTop.data.id] || []).map((m) => m.id === messageId
                                        ? (scope === "all" ? { ...m, text: t("ai_hdhft_alrsala"), type: "text", deleted: true, fileUrl: null } : null)
                                        : m).filter(Boolean));
                                    const last = after[after.length - 1];
                                    if (!last) return { ...c, lastMessage: "", lastFromMe: false, lastStatus: null };
                                    const preview = last.deleted ? t("ai_hdhft_alrsala")
                                        : (last.text || (last.type === "voice" ? t("ai_rsala_swtya") : last.fileName ? "📎 " + last.fileName : ""));
                                    return { ...c, lastMessage: preview, lastFromMe: last.senderUserId === myUserId, lastStatus: last.status || null };
                                }));
                                showToast(scope === "all" ? t("ai_hdhft_lljmya") : t("ai_hdhft_andk"), "success");
                            }, onOpenInfo: () => setChatsStack([...chatsStack, { type: "info", data: chatsTop.data }]), disappearing: SCc ? (liveConv.disappear || 0) : chatDisappearing, setDisappearing: SCc ? (v) => SCc.setDisappear(chatsTop.data.id, v) : setChatDisappearing, background: chatThemes[chatsTop.data.id] || "default", onBack: () => setChatsStack([]), myUserId: myUserId, isBlocked: blockedConversations.includes(chatsTop.data.id), groupPersons: groupPersons }));
                    }
                    if (chatsTop.type === "info") {
                        const convMessages = messagesByConversation[chatsTop.data.id] || [];
                        const liveConvI = conversations.find((c) => c.id === chatsTop.data.id) || chatsTop.data;
                        const SCi = cloudChat(chatsTop.data.id);
                        return (React.createElement(ChatInfoScreen, { conversation: liveConvI, messages: convMessages, background: chatThemes[chatsTop.data.id] || "default", setBackground: (themeKey) => setChatThemes((prev) => ({ ...prev, [chatsTop.data.id]: themeKey })), disappearing: SCi ? (liveConvI.disappear || 0) : chatDisappearing, setDisappearing: SCi ? (v) => SCi.setDisappear(chatsTop.data.id, v) : setChatDisappearing, isBlocked: blockedConversations.includes(chatsTop.data.id), onBlock: () => blockContact(chatsTop.data.id), onUnblock: () => unblockContact(chatsTop.data.id), onReport: (done) => { const SCr = window.SawaChat; if (SCr && SCr.reportSheet && SCi) SCr.reportSheet({ cid: chatsTop.data.id, name: liveConvI.name, kind: "dm", onBlock: () => blockContact(chatsTop.data.id), onDone: done }); else { showToast(t("tm_irsal_blaghk"), "success"); done && done(); } }, isLocked: lockedConversationIds.includes(chatsTop.data.id), onToggleLock: () => toggleChatLock(chatsTop.data.id), chatFolders: chatFolders, folderId: folderAssignments[chatsTop.data.id], onSetFolder: (folderId) => assignConversationFolder(chatsTop.data.id, folderId), notificationTone: conversationTones[chatsTop.data.id] || defaultNotificationTone, setNotificationTone: (tone) => setConversationTones((prev) => ({ ...prev, [chatsTop.data.id]: tone })), onBack: () => setChatsStack(chatsStack.slice(0, -1)) }));
                    }
                    if (chatsTop.type === "search") {
                        return (React.createElement(UnifiedSearchScreen, { conversations: conversations, groups: groups, shipments: shipments, taxiTripsHistory: taxiTripsHistory, messagesByConversation: messagesByConversation, groupMessages: groupMessages, onOpenChat: (c) => setChatsStack([{ type: "chat", data: c }]), onOpenGroup: (g) => setChatsStack([{ type: "group", data: g }]), onClose: () => setChatsStack([]) }));
                    }
                    if (chatsTop.type === "new") {
                        return React.createElement(NewConversationScreen, { onCreate: createConversation, onClose: () => setChatsStack([]),
                            contacts: (window.SawaChat && window.SawaChat.enabled && window.SawaChat.enabled()) ? people : null, onPickContact: (c) => messageContact(c) });
                    }
                    return null;
                })(),
                tab === "calls" && (React.createElement(CallsScreen, { onOpenScheduledRooms: () => setRoomsListOpen(true), groups: groups.filter((g) => /^(fam_|grp_)/.test(g.id || "")), callLog: callLog, favoriteContacts: favoriteContacts, onToggleFavorite: toggleFavoriteContact, onLogCall: logCall, callSettings: callSettings, onUpdateCallSettings: setCallSettings, speedDialContacts: speedDialContacts, onUpdateSpeedDial: setSpeedDialContacts, onClearCallLog: clearCallLog, onDeleteCallEntry: (id) => {
                        setCallLog((prev) => prev.filter((x) => x.id !== id));
                        showToast(t("hdhft_mn_alsjl"), "success");
                    }, scheduledCalls: scheduledCalls, onAddScheduledCall: addScheduledCall, onDeleteScheduledCall: deleteScheduledCall })),
                tab === "contacts" && React.createElement(ContactsScreen, { onMessageContact: messageContact, onLogCall: logCall, onlineContacts: onlineContacts, people: people }),
                tab === "discover" && discoverContent,
                tab === "me" && (React.createElement(MeScreen, { myProfile: myProfile, onExportTree: exportFamilyTree, onImportTree: importFamilyTree, onOpenSettings: () => setStack(["security"]), onOpenNotifications: () => setStack(["notifications"]), onOpenLinkedDevices: () => setShowLinkedDevices(true), onOpenWrapped: () => setShowWrapped(true), onOpenFeedback: () => setShowFeedback(true), onOpenHelp: () => setShowHelp(true), statusOption: statusOption, profilePhoto: profilePhoto, onLogout: handleLogout }))))),
            stack.length === 0
                && (tab !== "discover" || discoverStack.length === 0)
                // داخل محادثة أو مجموعة يُخفى شريط التنقّل: المساحة للرسائل،
                // والانتقال لقسم آخر وأنت تكتب لا معنى له
                && !(tab === "chats" && chatsStack.length > 0)
                // مصفوفة tabs مرتّبة من الأقلّ أهميةً (حسابي) إلى الأهمّ (محادثات)،
                // والتبويب الأهمّ يجب أن يقع عند بداية السطر في اللغتين.
                // flex-row-reverse ثابتة لا rowStart(): الـdir يقلب المحور أصلاً،
                // فـrowStart() تقلبه ثانيةً ويعود الترتيب الفيزيائي كما هو في اللغتين.
                && (React.createElement("div", { className: "flex flex-row-reverse border-t", style: { borderColor: colors.border, backgroundColor: colors.card } }, (IS_RAHIM ? tabs.filter((x) => x.key === "discover" || x.key === "me") : tabs).map((tabItem) => {
                const Icon = tabItem.icon;
                const active = tab === tabItem.key;
                return (React.createElement("button", { key: tabItem.key, onClick: () => { setTab(tabItem.key); if (tabItem.key !== "discover")
                        setDiscoverStack([]); if (tabItem.key !== "chats")
                        setChatsStack([]); }, className: "flex-1 flex flex-col items-center py-3 relative" },
                    React.createElement("div", { className: "relative" },
                        React.createElement(Icon, { size: 26, color: active ? colors.primary : colors.textMuted }),
                        tabItem.key === "calls" && missedNew > 0 && (React.createElement("span", { className: "absolute -top-1.5 -left-2 min-w-[14px] h-3.5 px-0.5 rounded-full flex items-center justify-center text-[8px] font-bold text-white", style: { backgroundColor: colors.danger } }, missedNew))),
                    React.createElement("span", { className: "text-[12px] mt-1 whitespace-nowrap leading-tight", style: { color: active ? colors.primary : colors.textMuted, fontWeight: active ? 800 : 600 } }, t(IS_RAHIM && tabItem.key === "discover" ? "sla_alrhm" : tabItem.labelKey)),
                    active && React.createElement("div", { className: "w-1.5 h-1.5 rounded-full mt-0.5", style: { backgroundColor: colors.primary } })));
            }))))),
        showAddSchedule && (() => { const schGid = (editingSchedule && editingSchedule.groupId) || (discoverTop && (discoverTop.type === "schedules" || discoverTop.type === "tree") && discoverTop.data && discoverTop.data.id) || (discoverTop && discoverTop.type === "personDetail" && discoverTop.groupId) || currentGroupId; return React.createElement(FamilyAddScheduleSheet, { allPersons: famPersons[schGid] || [], persons: (famPersons[schGid] || []).filter((p) => !isSelfPerson(p) && (p.alive !== false || (editingSchedule && editingSchedule.personId === p.id))), relations: kinshipRelations.filter((r) => r.groupId === schGid), preselectedPersonId: preselectedSchedulePersonId, initial: editingSchedule, onSave: (personId, action, freqKey) => (editingSchedule ? updateSchedule(editingSchedule.id, personId, action, freqKey) : addSchedule(schGid, personId, action, freqKey)), onClose: () => { setShowAddSchedule(false); setPreselectedSchedulePersonId(null); setEditingSchedule(null); } }); })(),
        showAddEvent && (() => { const evGid = (editingEvent && editingEvent.groupId) || (discoverTop && discoverTop.type === "events" && discoverTop.data && discoverTop.data.id) || (discoverTop && discoverTop.type === "personDetail" && discoverTop.groupId) || currentGroupId; return React.createElement(FamilyAddEventSheet, { persons: groupPersons[evGid] || [], relations: kinshipRelations.filter((r) => r.groupId === evGid), initial: editingEvent, onSave: (personId, type, title, ts, desc) => (editingEvent ? updateEvent(editingEvent.id, personId, type, title, ts, desc) : addEvent(evGid, personId, type, title, ts, desc)), onClose: () => { setShowAddEvent(false); setEditingEvent(null); } }); })(),
        bulkAddPreset && (React.createElement(QuickRelativesSheet, { person: bulkAddPreset.person, existingPersons: groupPersons[bulkAddPreset.groupId] || [], relations: kinshipRelations.filter((r) => r.groupId === bulkAddPreset.groupId), startRel: bulkAddPreset.startRel, onSave: (p, sel, names, decisions) => addRelativesBulk(bulkAddPreset.groupId, p, sel, names, decisions), onClose: () => setBulkAddPreset(null) })),
        gapAddPreset && (React.createElement(FamilyPersonFormSheet, { persons: groupPersons[gapAddPreset.groupId] || [], relations: kinshipRelations.filter((r) => r.groupId === gapAddPreset.groupId), presetRelatedToId: gapAddPreset.relatedToId, presetRelationType: gapAddPreset.relationType, presetKinship: gapAddPreset.presetKinship, presetGender: gapAddPreset.presetGender || null, onSave: (data) => addPerson(gapAddPreset.groupId, data), onClose: () => setGapAddPreset(null) })),
        schedulingRoom && (React.createElement(ScheduleRoomModal, { onSave: (r) => {
                // C8: غرفة مجدولة حقيقيّة — تظهر على أجهزتي ويصلني تذكير، وبطاقتها جاهزة وأنا مضيفها
                if ((window.SawaRTC && window.SawaRTC.enabled && window.SawaRTC.enabled())) { window.SawaRTC.schedSave({ room: r.code, description: r.title, contactName: r.title, timestamp: r.at, endTime: "", callType: "audio", reminderMinutes: 15 }).then(() => { setRoomsListOpen(true); try { if (window.SawaRTC.schedPublish) setTimeout(() => window.SawaRTC.schedPublish({ code: r.code, title: r.title, at: r.at }), 350); } catch (e) { } }).catch(() => showToast("تعذّر حفظ الموعد — تحقّق من الاتّصال", "error")); return; }
                setScheduledRooms((p) => [...p, r].sort((a, b) => a.at - b.at));
                setRoomsListOpen(true); showToast(tl("جُدولت الغرفة ✓ — تجدها هنا وفي «المكالمات» ← ⋮ ← «الغرف المجدولة»", "Room scheduled ✓"), "success");   // C17
            }, onClose: () => setSchedulingRoom(false) })),
        roomsListOpen && !schedulingRoom && (React.createElement("div", { className: "flex flex-col", style: { position: "fixed", inset: 0, zIndex: 55, backgroundColor: colors.bg, maxWidth: 480, margin: "0 auto" } },
            React.createElement(ScheduledRoomsScreen, { rooms: scheduledRooms, onBack: () => setRoomsListOpen(false), onNew: () => setSchedulingRoom(true),
                onJoin: (code) => { setRoomsListOpen(false); if (!((window.SawaRTC && window.SawaRTC.enabled && window.SawaRTC.enabled()) && window.SawaRTC.roomJoin(code))) setActiveRoom(code); },
                onCancel: (id) => { const sr = scheduledRooms.find((r) => r.id === id); if (sr && sr.cloud && window.SawaRTC) window.SawaRTC.schedRemove(id); else setScheduledRooms((p) => p.filter((r) => r.id !== id)); showToast(t("alghy_almwad"), "info"); } }))),
        pendingContributionTarget && (React.createElement(ContributionAmountModal, { onConfirm: confirmContribution, onClose: () => setPendingContributionTarget(null), walletBalance: walletBalance }))));
}
//@@sawa-part:8
