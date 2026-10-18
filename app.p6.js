function NewCallScreen({ onCall, onBack }) {
    const { colors } = useTheme();
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("mkalma_jdyda"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4" }, DEFAULT_CONTACTS.map((c) => (React.createElement(Card, { key: c.id, className: `flex ${rowStart()} items-center` },
            React.createElement("div", { className: `w-10 h-10 rounded-full flex items-center justify-center ${ms("3")} font-bold`, style: { backgroundColor: colors.primaryLight, color: colors.primaryDark } }, c.name.charAt(0)),
            React.createElement("span", { className: "flex-1 text-sm font-bold", style: { color: colors.text } }, c.name),
            React.createElement("button", { "aria-label": t("fydyw"), onClick: () => onCall(c.name, "video"), className: `w-9 h-9 rounded-full flex items-center justify-center ${ms("1.5")}`, style: { backgroundColor: colors.primaryLight } },
                React.createElement(Video, { size: 14, color: colors.primary })),
            React.createElement("button", { "aria-label": t("atsal"), onClick: () => onCall(c.name, "audio"), className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.primaryLight } },
                React.createElement(Phone, { size: 14, color: colors.primary }))))))));
}
function DialPadScreen({ onCall, onBack }) {
    const { colors } = useTheme();
    const [number, setNumber] = useState("");
    // C62: رمز سوا (10 أرقام) — لا * ولا #؛ يُعرض مقسّماً 3-3-4 كما في «رمزي»
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", ""];
    const shown = number ? number.replace(/(\d{3})(\d{0,3})(\d{0,4}).*/, (m, a, b, c) => [a, b, c].filter(Boolean).join(" ")) : "";
    const ready = number.length >= 8;
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: tl("اتّصل برمز سوا", "Call by Sawa code"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 flex flex-col items-center justify-between p-6", style: { backgroundColor: colors.bg } },
            React.createElement("div", { className: "w-full text-center pt-4" },
                React.createElement("span", { className: "text-2xl font-extrabold tracking-widest", style: { color: colors.text }, dir: "ltr" }, shown || "—"),
                React.createElement("div", { className: "text-xs mt-2", style: { color: colors.textMuted } }, tl("أدخل رمز سوا الخاصّ بالشخص (10 أرقام) — تجده عنده في «جهات الاتصال ← رمزي»", "Enter the person's 10-digit Sawa code (Contacts → My code)"))),
            React.createElement("div", { className: "grid grid-cols-3 gap-4 w-full max-w-xs" }, keys.map((k, i) => k === "" ? React.createElement("div", { key: "e" + i }) : (React.createElement("button", { key: k, onClick: () => setNumber((prev) => (prev + k).slice(0, 10)), className: "w-16 h-16 rounded-full flex items-center justify-center mx-auto", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement("span", { className: "text-xl font-bold", style: { color: colors.text } }, k))))),
            React.createElement("div", { className: `flex ${rowStart()} items-center gap-4 w-full max-w-xs justify-center` },
                React.createElement("button", { "aria-label": t("atsal"), onClick: () => ready && onCall(number), disabled: !ready, className: "w-16 h-16 rounded-full flex items-center justify-center", style: { backgroundColor: colors.success, opacity: ready ? 1 : 0.4 } },
                    React.createElement(Phone, { size: 22, color: "#fff" })),
                number.length > 0 && (React.createElement("button", { onClick: () => setNumber((prev) => prev.slice(0, -1)), className: "w-12 h-12 rounded-full flex items-center justify-center" },
                    React.createElement(Delete, { size: 18, color: colors.textMuted })))))));
}
function ScheduleCallScreen({ defaultCallType, onSave, onBack, groups = [] }) {
    var _a;
    const { colors } = useTheme();
    const [contactName, setContactName] = useState(((_a = DEFAULT_CONTACTS[0]) === null || _a === void 0 ? void 0 : _a.name) || "");
    const [description, setDescription] = useState("");
    const [date, setDate] = useState("");
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const [callType, setCallType] = useState(defaultCallType || "audio");
    const [requireApproval, setRequireApproval] = useState(false);
    const [reminderMinutes, setReminderMinutes] = useState(15);
    const minDate = new Date().toISOString().slice(0, 10);
    // إصلاح جوهري — إزالة أي حالة توقعن الزر بصمت: عند تعبئة وقت البداية،
    // نملأ وقت النهاية تلقائياً (بعد 30 دقيقة) لو لسا فارغاً، فالزر ما يبقى
    // معطَّلاً بلا تفسير واضح للمستخدم
    function handleStartTimeChange(value) {
        setStartTime(value);
        if (value && !endTime) {
            const [h, m] = value.split(":").map(Number);
            const total = h * 60 + m + 30;
            const newH = Math.floor(total / 60) % 24;
            const newM = total % 60;
            setEndTime(`${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`);
        }
    }
    // C7: الموعد مع جهة اتّصال أو مع مجموعة/عائلة (قيمة «g:معرّف»)
    const pickedGroup = String(contactName).indexOf("g:") === 0 ? groups.find((g) => "g:" + g.id === contactName) : null;
    const shownName = pickedGroup ? pickedGroup.name : contactName;
    const canSave = contactName && date && startTime && endTime;
    const reminderLabels = { 5: "قبل 5 دقائق", 15: "قبل 15 دقيقة", 30: "قبل 30 دقيقة", 60: "قبل ساعة" };
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("jdwla_mkalma"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            React.createElement("h3", { className: "text-base font-extrabold mb-4", style: { color: colors.text } },
                "\u0645\u0643\u0627\u0644\u0645\u0629 ",
                shownName),
            React.createElement("label", { className: "text-xs font-bold mb-1.5 block", style: { color: colors.text } }, t("ma")),
            React.createElement("select", { value: contactName, onChange: (e) => setContactName(e.target.value), className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-4", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }, DEFAULT_CONTACTS.map((c) => React.createElement("option", { key: c.id, value: c.name }, c.name)),
                groups.length > 0 && React.createElement("optgroup", { label: "المجموعات والعائلات" }, groups.map((g) => React.createElement("option", { key: g.id, value: "g:" + g.id }, "👥 " + g.name)))),
            React.createElement("label", { className: "text-xs font-bold mb-1.5 block", style: { color: colors.text } }, t("alwsf_akhtyary")),
            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: description, onChange: (e) => setDescription(e.target.value), placeholder: t("mthal_mtabaa_mshrwa_alaayla"), className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-4", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
            React.createElement("label", { className: "text-xs font-bold mb-1.5 block", style: { color: colors.text } }, t("altarykh")),
            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", type: "date", value: date, min: minDate, onChange: (e) => setDate(e.target.value), className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-4", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
            React.createElement("label", { className: "text-xs font-bold mb-1.5 block", style: { color: colors.text } }, t("alwqt")),
            React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 mb-4` },
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", type: "time", value: startTime, onChange: (e) => handleStartTimeChange(e.target.value), className: "flex-1 border rounded-xl px-3 py-2.5 text-sm", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, t("ila")),
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", type: "time", value: endTime, onChange: (e) => setEndTime(e.target.value), className: "flex-1 border rounded-xl px-3 py-2.5 text-sm", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } })),
            React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("nwa_almkalma")),
            React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-4` },
                React.createElement("button", { onClick: () => setCallType("audio"), className: `flex-1 rounded-xl border-2 py-2.5 flex ${rowStart()} items-center justify-center gap-1.5`, style: { borderColor: callType === "audio" ? colors.primary : colors.border } },
                    React.createElement(Phone, { size: 14, color: callType === "audio" ? colors.primary : colors.textMuted }),
                    React.createElement("span", { className: "text-xs font-bold", style: { color: colors.text } }, t("swtya"))),
                React.createElement("button", { onClick: () => setCallType("video"), className: `flex-1 rounded-xl border-2 py-2.5 flex ${rowStart()} items-center justify-center gap-1.5`, style: { borderColor: callType === "video" ? colors.primary : colors.border } },
                    React.createElement(Video, { size: 14, color: callType === "video" ? colors.primary : colors.textMuted }),
                    React.createElement("span", { className: "text-xs font-bold", style: { color: colors.text } }, t("fydyw")))),
            React.createElement(Card, { className: "mb-4" },
                React.createElement("div", { className: `flex ${rowStart()} items-center justify-between` },
                    React.createElement("div", { className: `flex-1 ${textStart()} ${ms("2")}` },
                        React.createElement("span", { className: "text-sm font-bold block", style: { color: colors.text } }, t("tlzm_almwafqa_llandmam")),
                        React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } }, t("ay_shkhs_yryd_aldkhwl"))),
                    React.createElement("button", { onClick: () => setRequireApproval(!requireApproval), className: "w-10 h-5 rounded-full relative shrink-0", style: { backgroundColor: requireApproval ? colors.primary : colors.border } },
                        React.createElement("span", { className: "absolute top-0.5 w-4 h-4 rounded-full bg-white", style: { [requireApproval ? "right" : "left"]: 2 } })))),
            React.createElement("label", { className: "text-xs font-bold mb-1.5 block", style: { color: colors.text } }, t("tdhkyr_qbl_almwad")),
            React.createElement("select", { value: reminderMinutes, onChange: (e) => setReminderMinutes(Number(e.target.value)), className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-5", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } },
                React.createElement("option", { value: 5 }, t("qbl_5_dqayq")),
                React.createElement("option", { value: 15 }, t("qbl_15_dqyqa")),
                React.createElement("option", { value: 30 }, t("qbl_30_dqyqa")),
                React.createElement("option", { value: 60 }, t("qbl_saaa"))),
            !canSave && (date || startTime) && (React.createElement("p", { className: "text-[11px] text-center mb-2", style: { color: colors.danger } }, t("akml_altarykh_wwqty_albdaya"))),
            React.createElement(Button, { label: t("hfz_almwad"), disabled: !canSave, onPress: () => onSave({
                    id: `sched-call-${Date.now()}`,
                    contactName: shownName, description, date, startTime, endTime, callType, requireApproval, reminderMinutes,
                    peerUid: pickedGroup ? undefined : ((DEFAULT_CONTACTS.find((c) => c.name === contactName) || {}).uid),
                    cid: pickedGroup ? pickedGroup.id : undefined,
                    timestamp: new Date(`${date}T${startTime}`).getTime(),
                }) }))));
}
function ScheduledCallsScreen({ scheduledCalls, onDelete, onJoinNow, onNewSchedule, onBack }) {
    const { colors } = useTheme();
    const sorted = [...scheduledCalls].sort((a, b) => a.timestamp - b.timestamp);
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("mkalmat_mjdwla"), onBack: onBack, actions: React.createElement("button", { "aria-label": t("idafa"), onClick: onNewSchedule, className: `${ms("2")}` },
                React.createElement(Plus, { size: 18, color: "#fff" })) }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            sorted.length === 0 && React.createElement(EmptyState, { icon: Calendar, label: t("ma_fyh_mkalmat_mjdwla") }),
            sorted.map((s) => (React.createElement(Card, { key: s.id, className: "mb-2" },
                React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-1.5` },
                    React.createElement("span", { className: "text-sm font-bold", style: { color: colors.text } }, s.contactName),
                    React.createElement("div", { className: `flex ${rowStart()} items-center gap-1` }, s.callType === "video" ? React.createElement(Video, { size: 13, color: colors.primary }) : React.createElement(Phone, { size: 13, color: colors.primary }))),
                React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 mb-1` },
                    React.createElement(Calendar, { size: 11, color: colors.textMuted }),
                    React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } },
                        new Date(s.date).toLocaleDateString(loc(), { day: "numeric", month: "long", year: "numeric" }),
                        " \u00B7 ",
                        s.startTime,
                        " - ",
                        s.endTime)),
                React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 mb-2` },
                    s.requireApproval ? React.createElement(Lock, { size: 11, color: colors.accent }) : React.createElement(Unlock, { size: 11, color: colors.textMuted }),
                    React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } },
                        s.requireApproval ? "تلزم الموافقة للانضمام" : "دخول مباشر بلا موافقة",
                        " \u00B7 \u062A\u0630\u0643\u064A\u0631 \u0642\u0628\u0644 ",
                        s.reminderMinutes,
                        " \u062F\u0642\u064A\u0642\u0629")),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("button", { onClick: () => onJoinNow(s), className: "flex-1 rounded-xl py-2", style: { backgroundColor: colors.primary } },
                        React.createElement("span", { className: "text-[11px] font-bold text-white" }, t("abda_alan"))),
                    React.createElement("button", { "aria-label": t("hdhf"), onClick: () => onDelete(s.id), className: "rounded-xl py-2 px-3 border", style: { borderColor: colors.danger } },
                        React.createElement(Trash2, { size: 13, color: colors.danger })))))))));
}
// C17: جدول الغرف المجدولة — كلّ غرفة: عنوانها، موعدها، الوقت المتبقّي (يتحدّث كلّ ثانية)، رابطها (نسخ/مشاركة)، دخول، إلغاء
function roomLeftText(ms) {
    const m = Math.ceil(ms / 60000);
    if (m <= 1) return tl("تبدأ خلال دقيقة", "Starts within a minute");
    if (m < 60) return tl("تبدأ بعد " + m + " دقيقة", "Starts in " + m + " min");
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return tl("تبدأ بعد " + h + " س" + (mm ? " و" + mm + " د" : ""), "Starts in " + h + "h" + (mm ? " " + mm + "m" : ""));
    const d = Math.floor(h / 24), hh = h % 24;
    return tl("تبدأ بعد " + (d === 1 ? "يوم" : d === 2 ? "يومين" : d + (d <= 10 ? " أيّام" : " يوماً")) + (hh ? " و" + hh + " س" : ""), "Starts in " + d + "d" + (hh ? " " + hh + "h" : ""));
}
function roomStatus(r, now) {
    const end = r.end || (r.at + 3600000);
    if (now < r.at) return { k: "soon", text: roomLeftText(r.at - now), live: r.at - now <= 15 * 60000 };
    if (now < end) return { k: "live", text: tl("🟢 جارية الآن", "🟢 Happening now") };
    return { k: "past", text: tl("انتهى موعدها", "Ended") };
}
function ScheduledRoomsScreen({ rooms = [], onJoin, onCancel, onNew, onBack }) {
    const { colors } = useTheme();
    const { showToast } = useToast();
    const [now, setNow] = useState(Date.now());
    useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv); }, []);
    useEffect(() => { try { if (window.SawaRTC && window.SawaRTC.schedRefresh) window.SawaRTC.schedRefresh(true); } catch (e) { } }, []);
    const list = [...rooms].map((r) => ({ r, st: roomStatus(r, now) })).filter((x) => x.st.k !== "past" || now - (x.r.end || x.r.at + 3600000) < 6 * 3600000)
        .sort((a, b) => (a.st.k === "past") - (b.st.k === "past") || a.r.at - b.r.at);
    const linkOf = (r) => r.link || (window.SawaRTC && window.SawaRTC.roomLink ? window.SawaRTC.roomLink(r.code) : "?room=" + r.code);
    const copy = (r) => { const l = linkOf(r); try { navigator.clipboard.writeText(l).then(() => showToast(tl("نُسخ الرابط ✓", "Link copied ✓"), "success"), () => window.prompt(tl("انسخ الرابط:", "Copy:"), l)); } catch (e) { window.prompt(tl("انسخ الرابط:", "Copy:"), l); } };
    const share = (r) => { const l = linkOf(r), txt = tl("أدعوك إلى غرفة سوا «" + r.title + "» — ", "Join my Sawa room «" + r.title + "» — ") + new Date(r.at).toLocaleString(loc(), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        try { if (window.SawaRTC && window.SawaRTC.schedPublish) { window.SawaRTC.schedPublish({ code: r.code, title: r.title, at: r.at }); return; } } catch (e) { }
        try { if (navigator.share) { navigator.share({ title: r.title, text: txt, url: l }).catch(() => { }); return; } } catch (e) { } copy(r); };
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: tl("الغرف المجدولة", "Scheduled rooms"), onBack: onBack, actions: React.createElement("button", { "aria-label": tl("جدولة غرفة", "Schedule a room"), onClick: onNew, className: `${ms("2")}` },
                React.createElement(Plus, { size: 18, color: "#fff" })) }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            list.length === 0 && React.createElement("div", { className: "flex flex-col items-center gap-3 mt-8" },
                React.createElement(EmptyState, { icon: CalendarDays, label: tl("لا غرف مجدولة بعد", "No scheduled rooms yet") }),
                React.createElement("button", { onClick: onNew, className: `flex ${rowStart()} items-center gap-2 px-4 py-2.5 rounded-2xl`, style: { backgroundColor: colors.primary } },
                    React.createElement(Plus, { size: 16, color: "#fff" }),
                    React.createElement("span", { className: "text-sm font-bold text-white" }, tl("جدولة غرفة", "Schedule a room")))),
            list.map(({ r, st }) => (React.createElement(Card, { key: r.id, className: "mb-2.5", style: { opacity: st.k === "past" ? 0.6 : 1, border: st.k === "live" ? "2px solid #22c55e" : undefined } },
                React.createElement("div", { className: `flex ${rowStart()} items-start justify-between gap-2` },
                    React.createElement("div", { style: { minWidth: 0, flex: 1 } },
                        React.createElement("p", { className: "text-sm font-extrabold truncate", style: { color: colors.text } }, r.title),
                        React.createElement("p", { className: "text-[11px] mt-0.5", style: { color: colors.textMuted } },
                            new Date(r.at).toLocaleString(loc(), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))),
                    React.createElement("span", { className: "text-[11px] font-extrabold px-2 py-1 rounded-lg shrink-0", style: { color: st.k === "live" ? "#15803d" : st.k === "past" ? colors.textMuted : st.live ? "#b45309" : colors.primary, backgroundColor: st.k === "live" ? "#dcfce7" : st.k === "past" ? colors.bg : st.live ? "#fef3c7" : colors.primaryLight } }, st.text)),
                React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 mt-2.5 rounded-xl px-2.5 py-2`, style: { backgroundColor: colors.bg } },
                    React.createElement(Link2, { size: 14, color: colors.textMuted, className: "shrink-0" }),
                    React.createElement("span", { className: "text-[11px] font-bold flex-1 truncate", dir: "ltr", style: { color: colors.text, textAlign: "left" } }, linkOf(r).replace(/^https?:\/\//, "")),
                    React.createElement("button", { "aria-label": tl("نسخ الرابط", "Copy link"), onClick: () => copy(r), className: "shrink-0 p-1" }, React.createElement(Copy, { size: 15, color: colors.primary })),
                    React.createElement("button", { "aria-label": tl("مشاركة الرابط", "Share link"), onClick: () => share(r), className: "shrink-0 p-1" }, React.createElement(Share2, { size: 15, color: colors.primary }))),
                st.k !== "past" && React.createElement("div", { className: `flex ${rowStart()} gap-2 mt-2.5` },
                    React.createElement("button", { onClick: () => onJoin(r.code), className: "flex-1 rounded-xl py-2.5", style: { backgroundColor: st.k === "live" || st.live ? "#16a34a" : colors.primary } },
                        React.createElement("span", { className: "text-xs font-extrabold text-white" }, st.k === "live" ? tl("ادخل الآن", "Join now") : tl("دخول الغرفة", "Enter room"))),
                    React.createElement("button", { onClick: () => share(r), className: `flex ${rowStart()} items-center justify-center gap-1.5 rounded-xl py-2.5 px-3.5 border`, style: { borderColor: colors.primary } },
                        React.createElement(Share2, { size: 14, color: colors.primary }),
                        React.createElement("span", { className: "text-xs font-extrabold", style: { color: colors.primary } }, tl("نشر", "Share"))),
                    React.createElement("button", { "aria-label": r.mine === false ? tl("إزالة من مواعيدي", "Remove") : tl("إلغاء الموعد", "Cancel"), onClick: () => { if (window.confirm(r.mine === false ? tl("إزالة «" + r.title + "» من مواعيدك؟", "Remove «" + r.title + "»?") : tl("إلغاء موعد «" + r.title + "» للجميع؟", "Cancel «" + r.title + "» for everyone?"))) onCancel(r.id); }, className: "rounded-xl py-2 px-3 border", style: { borderColor: colors.danger } },
                        React.createElement(Trash2, { size: 14, color: colors.danger })))))))));
}
function SpeedDialScreen({ speedDialContacts, onUpdate, onCall, onBack }) {
    const { colors } = useTheme();
    const [showAdd, setShowAdd] = useState(false);
    const available = DEFAULT_CONTACTS.filter((c) => !speedDialContacts.includes(c.name));
    function move(name, direction) {
        const idx = speedDialContacts.indexOf(name);
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= speedDialContacts.length)
            return;
        const next = [...speedDialContacts];
        [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
        onUpdate(next);
    }
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("alarqam_almfdla"), onBack: onBack, actions: React.createElement("button", { "aria-label": t("idafa"), onClick: () => setShowAdd(!showAdd), className: `${ms("2")}` },
                React.createElement(Plus, { size: 18, color: "#fff" })) }),
        showAdd && (React.createElement("div", { className: "p-3 border-b", style: { borderColor: colors.border, backgroundColor: colors.card } },
            React.createElement("p", { className: "text-xs font-bold mb-2", style: { color: colors.textMuted } }, t("akhtr_mn_jhat_alatsal")),
            available.length === 0 ? (React.createElement("p", { className: "text-xs", style: { color: colors.textMuted } }, t("kl_jhat_alatsal_mdafa"))) : (available.map((c) => (React.createElement("button", { "aria-label": t("idafa"), key: c.id, onClick: () => { onUpdate([...speedDialContacts, c.name]); setShowAdd(false); }, className: `w-full flex ${rowStart()} items-center gap-2 py-2` },
                React.createElement(Plus, { size: 13, color: colors.primary }),
                React.createElement("span", { className: "text-xs font-bold", style: { color: colors.text } }, c.name))))))),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4" },
            speedDialContacts.length === 0 && React.createElement(EmptyState, { icon: Star, label: t("ma_fyh_arqam_mfdla") }),
            speedDialContacts.map((name, i) => (React.createElement(Card, { key: name, className: `flex ${rowStart()} items-center` },
                React.createElement("div", { className: `flex flex-col ${ms("1")}` },
                    React.createElement("button", { onClick: () => move(name, -1), disabled: i === 0 },
                        React.createElement(ChevronUp, { size: 13, color: i === 0 ? colors.border : colors.textMuted })),
                    React.createElement("button", { onClick: () => move(name, 1), disabled: i === speedDialContacts.length - 1 },
                        React.createElement(ChevronDown, { size: 13, color: i === speedDialContacts.length - 1 ? colors.border : colors.textMuted }))),
                React.createElement("div", { className: `w-9 h-9 rounded-full flex items-center justify-center ${ms("2")}`, style: { backgroundColor: colors.primaryLight } },
                    React.createElement("span", { className: "text-xs font-extrabold", style: { color: colors.primaryDark } }, name.charAt(0))),
                React.createElement("span", { className: "flex-1 text-sm font-bold", style: { color: colors.text } }, name),
                React.createElement("button", { "aria-label": t("atsal"), onClick: () => onCall(name), className: `w-9 h-9 rounded-full flex items-center justify-center ${ms("1.5")}`, style: { backgroundColor: colors.primaryLight } },
                    React.createElement(Phone, { size: 14, color: colors.primary })),
                React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => onUpdate(speedDialContacts.filter((n) => n !== name)) },
                    React.createElement(X, { size: 15, color: colors.danger }))))))));
}
// وقت المكالمة الحقيقيّة: «اليوم 3:20م» / «أمس 9:15ص» / «12/10 8:00م»
function callTimeLabel(ts) {
    const d = new Date(ts), n = new Date();
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
    const ar = isRTL();
    const hm = ar ? `${h % 12 || 12}:${m}${h < 12 ? "ص" : "م"}` : `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(n) - day(d)) / 86400000);
    if (diff === 0) return (ar ? "اليوم " : "Today ") + hm;
    if (diff === 1) return (ar ? "أمس " : "Yesterday ") + hm;
    return `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}
// C6: السجلّ حقيقيّ (SawaRTC يضيف مكالماتك) — بلا أمثلةٍ وهميّة
const initialCallLog = [];
const callTypeIcons = { incoming: PhoneIncoming, outgoing: PhoneOutgoing, missed: PhoneMissed };
const callTypeColors = { incoming: "success", outgoing: "success", missed: "danger" };
function CallsScreen({ onOpenScheduledRooms, groups = [], callLog, favoriteContacts, onToggleFavorite, onLogCall, callSettings, onUpdateCallSettings, speedDialContacts, onUpdateSpeedDial, onClearCallLog, scheduledCalls, onAddScheduledCall, onDeleteScheduledCall, onDeleteCallEntry, }) {
    const { colors } = useTheme();
    const [activeCall, setActiveCallRaw] = useState(null); // null | { name, callType }
    // C6: جهة اتّصالٍ على سوا ⇒ مكالمةٌ حقيقيّة؛ غير ذلك (لوحة الأرقام…) الواجهة التجريبيّة
    const setActiveCall = (v) => {
        if (v && v.room && window.SawaRTC && window.SawaRTC.enabled() && window.SawaRTC.roomJoin(v.room)) return;   // C8: سجلّ غرفة
        if (v && v.cid && window.SawaRTC && window.SawaRTC.enabled() && window.SawaRTC.groupCall(v.cid, v.callType)) return;   // C7: سجلّ مكالمة جماعيّة
        if (v && cloudCallTo(v.peerUid ? { uid: v.peerUid, name: v.name } : v.name, v.callType)) return;
        // C62: لا شاشة مكالمةٍ وهميّة أبداً (كانت «لوحة الأرقام» و«المفضّلة» تفتح واجهةً تجريبيّة تقول «يتصل…» ولا تنتهي)
        if (v) { showToast(CALL_FAIL_MSG(), "error"); return; }
        setActiveCallRaw(v);
    };
    const [subScreen, setSubScreen] = useState(null); // null | "settings" | "speedDial"
    const [showMenu, setShowMenu] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [callMenu, setCallMenu] = useState(null); // مكالمة مختارة من السجل
    // C26: فتح «المكالمات» يُزيل إشعارات «مكالمة فائتة» (والرنين القديم) من شريط الإشعارات. (C31: كان بعد return مبكّر ⇒ خطأ React #300)
    useEffect(() => { try { if (window.SawaRTC && window.SawaRTC.clearCallNotifications) window.SawaRTC.clearCallNotifications(); } catch (e) { } }, []);
    if (activeCall) {
        return (React.createElement(CallOverlay, { contactName: activeCall.name, callType: activeCall.callType, availableContacts: [...new Set(callLog.map((x) => x.name))], requireApproval: callSettings.requireApproval, onEnd: (duration, wasConnected, participants) => {
                onLogCall(activeCall.name, activeCall.callType, duration, wasConnected, participants);
                setActiveCall(null);
            } }));
    }
    if (subScreen === "settings") {
        return (React.createElement(CallSettingsScreen, { settings: callSettings, onUpdate: onUpdateCallSettings, onClearLog: onClearCallLog, onOpenSpeedDial: () => setSubScreen("speedDial"), onBack: () => setSubScreen(null) }));
    }
    if (subScreen === "speedDial") {
        return (React.createElement(SpeedDialScreen, { speedDialContacts: speedDialContacts, onUpdate: onUpdateSpeedDial, onCall: (name) => { setSubScreen(null); setActiveCall({ name, callType: "audio" }); }, onBack: () => setSubScreen(null) }));
    }
    if (subScreen === "dialPad") {
        // C62: الأرقام هنا رمز سوا (10 أرقام) لا رقم هاتف — يفتح بطاقة الشخص: اتصال إن كان جهة اتّصال، أو طلب تواصل
        return React.createElement(DialPadScreen, { onCall: (number) => { setSubScreen(null); if (window.SawaChat && window.SawaChat.findSheet) window.SawaChat.findSheet(number.replace(/\D/g, "")); else showToast(CALL_FAIL_MSG(), "error"); }, onBack: () => setSubScreen(null) });
    }
    if (subScreen === "newCall") {
        return (React.createElement(NewCallScreen, { onCall: (name, callType) => { setSubScreen(null); setActiveCall({ name, callType }); }, onBack: () => setSubScreen(null) }));
    }
    if (subScreen === "schedule") {
        return (React.createElement(ScheduleCallScreen, { groups: groups, defaultCallType: callSettings.defaultScheduleType, onSave: (entry) => { onAddScheduledCall(entry); setSubScreen(null); }, onBack: () => setSubScreen(null) }));
    }
    if (subScreen === "scheduledList") {
        return (React.createElement(ScheduledCallsScreen, { scheduledCalls: scheduledCalls, onDelete: onDeleteScheduledCall, onJoinNow: (entry) => { setSubScreen(null); if (entry.cloud && window.SawaRTC && window.SawaRTC.schedStart(entry)) return; setActiveCall({ name: entry.contactName, callType: entry.callType }); }, onNewSchedule: () => setSubScreen("schedule"), onBack: () => setSubScreen(null) }));
    }
    const missedCount = callLog.filter((c) => c.type === "missed").length;
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 overflow-y-auto relative", style: { backgroundColor: colors.card } },
        React.createElement("div", { style: { display: "flex", flexDirection: isRTL() ? "row" : "row-reverse", direction: "ltr", alignItems: "center", padding: "1rem 1rem 0 1rem" } },
            React.createElement("div", { style: { flex: 1, display: "flex", flexDirection: isRTL() ? "row" : "row-reverse", justifyContent: "flex-start", alignItems: "center", gap: 8 } },
                React.createElement("button", { "aria-label": t("khyarat"), onClick: () => setShowMenu(!showMenu), className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.bg } },
                    React.createElement(MoreVertical, { size: 18, color: colors.textMuted })),
                React.createElement("button", { "aria-label": t("bhth"), onClick: () => setSubScreen("newCall"), className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.bg } },
                    React.createElement(Search, { size: 16, color: colors.textMuted }))),
            React.createElement("div", { style: { flex: 1, display: "flex", justifyContent: "center" } }),
            React.createElement("div", { style: { flex: 1, display: "flex", justifyContent: isRTL() ? "flex-end" : "flex-start" } },
                React.createElement("h2", { dir: isRTL() ? "rtl" : "ltr", className: "text-xl font-extrabold", style: { color: colors.text } }, t("mkalmat")))),
        showMenu && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowMenu(false), style: { position: "fixed", inset: 0, zIndex: 15 } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", top: "4.5rem", [isRTL() ? "left" : "right"]: "1rem", zIndex: 20, backgroundColor: colors.card, borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,0.18)", overflow: "hidden", minWidth: 200 } },
                React.createElement("button", { onClick: () => { setShowClearConfirm(true); setShowMenu(false); }, className: `w-full ${textStart()} px-4 py-3.5 border-b`, style: { borderColor: colors.border } },
                    React.createElement("span", { className: "text-sm", style: { color: colors.text } }, t("msh_sjl_almkalmat"))),
                React.createElement("button", { onClick: () => { setSubScreen("scheduledList"); setShowMenu(false); }, className: `w-full ${textStart()} px-4 py-3.5 border-b`, style: { borderColor: colors.border } },
                    React.createElement("span", { className: "text-sm", style: { color: colors.text } }, t("mkalmat_mjdwla"))),
                onOpenScheduledRooms && React.createElement("button", { onClick: () => { setShowMenu(false); onOpenScheduledRooms(); }, className: `w-full ${textStart()} px-4 py-3.5 border-b`, style: { borderColor: colors.border } },
                    React.createElement("span", { className: "text-sm", style: { color: colors.text } }, tl("الغرف المجدولة", "Scheduled rooms"))),
                React.createElement("button", { onClick: () => { setSubScreen("settings"); setShowMenu(false); }, className: `w-full ${textStart()} px-4 py-3.5` },
                    React.createElement("span", { className: "text-sm", style: { color: colors.text } }, t("aliadadat")))))),
        showClearConfirm && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setShowClearConfirm(false), style: { position: "fixed", inset: 0, zIndex: 25, backgroundColor: "rgba(0,0,0,0.4)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", top: "40%", left: "1.5rem", right: "1.5rem", zIndex: 26, backgroundColor: colors.card, borderRadius: 16, padding: 16 } },
                React.createElement("p", { className: "text-xs font-bold text-center mb-3", style: { color: colors.danger } }, t("msh_kl_sjl_almkalmat")),
                React.createElement("div", { className: "flex flex-row gap-2" },
                    React.createElement(Button, { label: t("msh_nhayya"), onPress: () => { onClearCallLog(); setShowClearConfirm(false); }, style: { flex: 1, backgroundColor: colors.danger } }),
                    React.createElement(Button, { label: t("ilgha"), variant: "outline", onPress: () => setShowClearConfirm(false), style: { flex: 1 } }))))),
        React.createElement("div", { className: "grid grid-cols-4 gap-2 px-4 pt-5" },
            React.createElement("button", { onClick: () => setSubScreen("newCall"), className: "flex flex-col items-center gap-1.5" },
                React.createElement("div", { className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: "#F0F0F0" } },
                    React.createElement(Phone, { size: 20, color: "#4A4A4A" })),
                React.createElement("span", { className: "text-[11px]", style: { color: colors.text } }, t("mkalma"))),
            React.createElement("button", { onClick: () => setSubScreen("schedule"), className: "flex flex-col items-center gap-1.5" },
                React.createElement("div", { className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: "#F0F0F0" } },
                    React.createElement(Calendar, { size: 20, color: "#4A4A4A" })),
                React.createElement("span", { className: "text-[11px]", style: { color: colors.text } }, t("jdwla"))),
            React.createElement("button", { onClick: () => setSubScreen("dialPad"), className: "flex flex-col items-center gap-1.5" },
                React.createElement("div", { className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: "#F0F0F0" } },
                    React.createElement(Grid3x3, { size: 20, color: "#4A4A4A" })),
                React.createElement("span", { className: "text-[11px]", style: { color: colors.text } }, t("lwha_alarqam"))),
            React.createElement("button", { onClick: () => setSubScreen("speedDial"), className: "flex flex-col items-center gap-1.5" },
                React.createElement("div", { className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: "#F0F0F0" } },
                    React.createElement(Heart, { size: 20, color: "#4A4A4A" })),
                React.createElement("span", { className: "text-[11px]", style: { color: colors.text } }, t("almfdla_2")))),
        React.createElement("div", { className: "px-4 pt-5 pb-1" },
            React.createElement("span", { className: "text-[15px] font-bold", style: { color: colors.text } }, t("alhdytha"))),
        React.createElement("div", { className: "pb-20" },
            callLog.length === 0 && React.createElement(EmptyState, { icon: Phone, label: t("la_twjd_mkalmat_bad") }),
            callLog.map((c) => {
                const Icon = callTypeIcons[c.type];
                const unanswered = c.type === "missed" || (!c.duration && c.cloud);
                const arrowColor = c.type === "missed" ? "#E53935" : unanswered ? "#D97706" : "#22C55E";
                // C61: الصفّ كلّه ينقر (كان الهاتف الصغير و⋮ فقط) ⇒ قائمة الخيارات: صوت · فيديو · حذف
                return (React.createElement("div", { key: c.id, role: "button", tabIndex: 0, onClick: () => setCallMenu(c), onKeyDown: (e) => { if (e.key === "Enter") setCallMenu(c); }, className: "flex flex-row items-center px-4 py-2.5 border-b cursor-pointer", style: { borderColor: "#EFEFEF" } },
                    (() => { const ph = c.peerUid && window.SawaChat && window.SawaChat.photoOf ? window.SawaChat.photoOf(c.peerUid) : null;
                        return React.createElement("div", { className: `w-11 h-11 rounded-full flex items-center justify-center ${me("3")} shrink-0`, style: { backgroundColor: colors.primaryLight, backgroundImage: ph ? `url(${ph})` : "none", backgroundSize: "cover", backgroundPosition: "center" } },
                            ph ? null : c.room || c.cid ? React.createElement(Users, { size: 19, color: colors.primaryDark }) : React.createElement(User, { size: 19, color: colors.primaryDark })); })(),
                    React.createElement("div", { className: "flex-1 min-w-0" },
                        React.createElement("div", { className: "text-[15px]", style: { color: c.type === "missed" ? "#E53935" : colors.text, fontWeight: 500 } },
                            c.name,
                            (c.participants && c.participants.length > 0) && React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.textMuted } }, " + " + c.participants.length)),
                        React.createElement("div", { className: "flex flex-row items-center gap-1 mt-0.5" },
                            React.createElement(Icon, { size: 12, color: arrowColor }),
                            c.callType === "video" && React.createElement(Video, { size: 10, color: colors.textMuted }),
                            React.createElement("span", { className: "text-xs", style: { color: c.type === "missed" ? "#E53935" : colors.textMuted } },
                                c.label ? `${c.label} · ` : "",
                                (c.cloud && c.timestamp ? callTimeLabel(c.timestamp) : c.time),
                                c.duration ? ` · ${c.duration}` : "",
                                (c.participants && c.participants.length > 0) ? ` · ${tl("مع", "with")} ${c.participants.join(tl("، ", ", "))}` : ""))),
                    React.createElement("button", { "aria-label": c.callType === "video" ? tl("مكالمة فيديو", "Video call") : tl("مكالمة صوتية", "Voice call"), onClick: (e) => { e.stopPropagation(); setActiveCall({ name: c.name, peerUid: c.peerUid, cid: c.cid, room: c.room, callType: c.callType || "audio" }); }, className: "w-9 h-9 flex items-center justify-center shrink-0" }, c.callType === "video" ? React.createElement(Video, { size: 19, color: colors.primary }) : React.createElement(Phone, { size: 19, color: colors.primary })),
                    React.createElement("button", { "aria-label": t("khyarat"), onClick: (e) => { e.stopPropagation(); setCallMenu(c); }, className: "w-7 h-7 flex items-center justify-center shrink-0" },
                        React.createElement(MoreVertical, { size: 16, color: colors.textMuted }))));
            })),
        callMenu && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setCallMenu(null), style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.35)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 41, backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 12 } },
                React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto my-3", style: { backgroundColor: colors.border } }),
                React.createElement("p", { className: "text-sm font-extrabold text-center mb-2", style: { color: colors.text } }, callMenu.name),
                [
                    { icon: Phone, label: tl("مكالمة صوتية", "Voice call"), act: () => setActiveCall({ name: callMenu.name, peerUid: callMenu.peerUid, cid: callMenu.cid, callType: "audio" }) },
                    { icon: Video, label: tl("مكالمة فيديو", "Video call"), act: () => setActiveCall({ name: callMenu.name, peerUid: callMenu.peerUid, cid: callMenu.cid, callType: "video" }) },
                    { icon: Trash2, label: tl("حذف من السجل", "Remove from history"), act: () => onDeleteCallEntry === null || onDeleteCallEntry === void 0 ? void 0 : onDeleteCallEntry(callMenu.id), danger: true },
                ].map((it) => (React.createElement("button", { key: it.label, onClick: () => { it.act(); setCallMenu(null); }, className: "w-full flex flex-row items-center gap-3 px-5 py-3.5 border-t", style: { borderColor: colors.border } },
                    React.createElement(it.icon, { size: 17, color: it.danger ? colors.danger : colors.textMuted }),
                    React.createElement("span", { className: `flex-1 ${textStart()} text-sm font-bold`, style: { color: it.danger ? colors.danger : colors.text } }, it.label))))))),
        React.createElement("button", { onClick: () => setSubScreen("newCall"), className: "flex items-center justify-center", "aria-label": t("mkalma_jdyda"), style: { position: "absolute", bottom: "1rem", [isRTL() ? "left" : "right"]: "1rem", width: 56, height: 56, borderRadius: 28, backgroundColor: "#25D366", boxShadow: "0 4px 12px rgba(0,0,0,0.25)" } },
            React.createElement(PhoneCall, { size: 22, color: "#fff" }))));
}
// ============================================================================
// جهات الاتصال — نفس تبويب سوا الأصلي
// ============================================================================
// ⛔ لا جهات اتّصال وهميّة (C1): القائمة الحيّة من SawaChat — أعضاء عائلاتي على السحابة + من أضفتهم برابطٍ شخصيّ.
//    يحدّثها AppInner في كلّ رسم (setLiveContacts)، فتقرؤها شاشات المكالمات والاتّصال السريع كما كانت تقرأ القائمة الثابتة.
let DEFAULT_CONTACTS = [];
function setLiveContacts(list) { DEFAULT_CONTACTS = Array.isArray(list) ? list : []; }
// C6: مكالمةٌ حقيقيّة (SawaRTC) لجهة اتّصالٍ على سوا — بالكائن {uid,name} أو بالاسم. تُرجع false إن لم تكن ممكنة
// (غير مسجّل / رقمٌ من لوحة الأرقام / اسمٌ ليس في جهات الاتّصال) فتبقى الواجهة القديمة.
// C14: تعذّرت المكالمة الحقيقيّة ⇒ نقول ذلك (كانت تظهر شاشة «مكالمة مشفّرة… متّصل» وتُسجَّل في السجلّ دون اتّصال)
function CALL_FAIL_MSG() {
    const R = window.SawaRTC;
    if (R && R.busy && R.busy()) return tl("أنت في مكالمة الآن", "You're already in a call");
    if (!(window.RTCPeerConnection && navigator.mediaDevices)) return tl("هذا المتصفّح لا يدعم المكالمات", "This browser doesn't support calls");
    return tl("تعذّر بدء المكالمة الآن — تأكّد من الاتّصال بالإنترنت وأعد المحاولة", "Couldn't start the call — check your connection and try again");
}
function cloudCallTo(who, callType) {
    const R = window.SawaRTC;
    if (!R || !R.enabled || !R.enabled()) return false;
    const c = who && typeof who === "object" ? who : DEFAULT_CONTACTS.find((x) => x.name === who);
    if (!c || !c.uid) return false;
    return !!R.call(c.uid, c.name, callType === "video" ? "video" : "audio");
}
function lastSeenLabel(ts) { return ts ? t("ct_last_seen", { t: formatChatTime(ts) }) : ""; }
function contactSubtitle(c, isOnline) {
    if (isOnline) return t("cp_mtsl_alan");
    if (c.lastSeen) return lastSeenLabel(c.lastSeen);
    if (c.families && c.families.length) return c.families.map((f) => f.name).join(" · ");
    if (c.via && c.via.indexOf("link") >= 0) return t("ct_link_contact");
    return c.phone || "";
}
// C24: البحث يتجاهل الهمزات والتشكيل والتاء المربوطة/الهاء والأرقام العربيّة
function normAr(s) {
    return String(s || "").toLowerCase().replace(/[ً-ْٰـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
        .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\s+/g, " ").trim();
}
// C24: شاشة جهات الاتّصال — تصفية (الكلّ · متّصلون · محظورون)، بحثٌ أذكى، اختصاراتٌ للإضافة،
//      وملفّ الشخص: رسالة · اتّصال · فيديو · سرّيّة، ثمّ التسمية والحظر والإزالة والإبلاغ (بتأكيد)
function ContactsScreen({ onMessageContact, onSwitchTab, onLogCall, onlineContacts, people = [] }) {
    const { colors } = useTheme();
    const { showToast } = useToast();
    const SC = window.SawaChat;
    const contacts = people;   // حقيقيّة من SawaChat
    const isOn = (c) => (c.online !== undefined ? c.online : onlineContacts.includes(c.name));
    const blockedOf = (c) => !!(c && c.uid && SC && SC.isBlocked && SC.isBlocked(c.uid));
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");   // all | online | blocked
    const [selectedId, setSelectedId] = useState(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [, bump] = useState(0);
    const reqCount = useSawaRequests();
    const sectionRefs = useRef({});
    const q = normAr(search);
    const matches = (c) => !q || [c.name, c.realName, c.nick, c.phone, c.tag].some((x) => x && normAr(x).includes(q));
    const onlineCount = contacts.filter(isOn).length, blockedCount = contacts.filter(blockedOf).length;
    const view = filter === "blocked" && !blockedCount ? "all" : filter;
    const filtered = contacts.filter(matches).filter((c) => view === "online" ? isOn(c) : view === "blocked" ? blockedOf(c) : true);
    const sawaContacts = filtered.filter((c) => c.onSawa);
    const phoneContacts = filtered.filter((c) => !c.onSawa);
    const grouped = {};
    [...sawaContacts].sort((a, b) => a.name.localeCompare(b.name, "ar")).forEach((c) => {
        const letter = (normAr(c.name).charAt(0) || "#").toUpperCase();
        (grouped[letter] = grouped[letter] || []).push(c);
    });
    const letters = Object.keys(grouped).sort((a, b) => a.localeCompare(b, "ar"));
    const selected = selectedId ? contacts.find((c) => c.id === selectedId) || null : null;
    const close = () => setSelectedId(null);
    // ⛔ لا شاشة مكالمةٍ وهميّة: تعذّرت المكالمة الحقيقيّة ⇒ نقول ذلك
    const callReal = (c, type) => { if (!cloudCallTo(c, type)) showToast(CALL_FAIL_MSG(), "error"); };
    const chip = (key, label, n) => React.createElement("button", { key, onClick: () => setFilter(key), className: "px-3 py-1.5 rounded-full text-xs font-bold shrink-0", style: { backgroundColor: view === key ? colors.primary : colors.card, color: view === key ? "#fff" : colors.text, border: `1px solid ${view === key ? colors.primary : colors.border}` } }, label + (n != null ? " · " + n : ""));
    const quick = (icon, label, onPress) => React.createElement("button", { onClick: onPress, className: "flex-1 flex flex-col items-center gap-1.5 rounded-2xl py-3", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
        React.createElement("div", { className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.primaryLight } }, React.createElement(icon, { size: 17, color: colors.primary })),
        React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.text } }, label));
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col relative", style: { backgroundColor: colors.bg } },
        React.createElement("div", { className: "px-4 pt-5 pb-2" },
            React.createElement("div", { className: "flex flex-row items-center justify-between mb-3" },
                React.createElement("div", { className: "flex flex-row items-center gap-2" },
                    React.createElement("h2", { className: "text-xl font-extrabold", style: { color: colors.text } }, t("jhat_atsal")),
                    React.createElement("span", { className: "text-xs font-bold px-2 py-0.5 rounded-full", style: { backgroundColor: colors.primaryLight, color: colors.primary } }, contacts.length)),
                SC && SC.codeSheet && React.createElement("button", { "aria-label": tl("رمزي في سوا", "My Sawa code"), onClick: () => SC.codeSheet(), className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                    React.createElement(QrCode, { size: 17, color: colors.primary }))),
            React.createElement("div", { className: "flex flex-row items-center gap-2 px-3 py-2.5 rounded-2xl", style: { backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                React.createElement(Search, { size: 15, color: colors.textMuted }),
                React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: search, onChange: (e) => setSearch(e.target.value), placeholder: tl("ابحث بالاسم أو التسمية", "Search by name"), className: "flex-1 bg-transparent text-sm outline-none", style: { color: colors.text, minWidth: 0 } }),
                search ? React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => setSearch("") }, React.createElement(X, { size: 14, color: colors.textMuted })) : null),
            contacts.length > 0 && React.createElement("div", { className: "flex flex-row gap-2 mt-3 overflow-x-auto", style: { scrollbarWidth: "none" } },
                chip("all", tl("الكلّ", "All"), contacts.length),
                chip("online", tl("متّصلون الآن", "Online"), onlineCount),
                blockedCount > 0 && chip("blocked", tl("المحظورون", "Blocked"), blockedCount))),
        React.createElement("div", { className: "flex-1 overflow-y-auto pb-24" },
            reqCount > 0 && SC && SC.requestsSheet && React.createElement("button", { onClick: () => SC.requestsSheet(), className: "mx-4 mt-1 mb-2 flex flex-row items-center gap-2 rounded-2xl px-3 py-2.5", style: { width: "calc(100% - 2rem)", backgroundColor: colors.primaryLight, border: `1px solid ${colors.primary}33` } },
                React.createElement(UserPlus, { size: 18, color: colors.primary }),
                React.createElement("span", { className: `flex-1 text-sm font-extrabold ${textStart()}`, style: { color: colors.primary } }, tl("طلبات تواصل جديدة", "New contact requests")),
                React.createElement("span", { className: "text-xs font-extrabold px-2 py-0.5 rounded-full", style: { backgroundColor: "#E11D48", color: "#fff" } }, reqCount)),
            !q && view === "all" && SC && SC.findSheet && React.createElement("div", { className: "flex flex-row gap-2 px-4 mt-1 mb-2" },
                quick(UserPlus, tl("أدخل رمز شخص", "Enter a code"), () => SC.findSheet()),
                quick(QrCode, tl("رمزي", "My code"), () => SC.codeSheet()),
                quick(Share2, tl("دعوة صديق", "Invite a friend"), () => SC.shareInvite && SC.shareInvite())),
            sawaContacts.length > 0 && letters.map((letter) => (React.createElement("div", { key: letter, ref: (el) => (sectionRefs.current[letter] = el) },
                React.createElement("div", { className: "px-4 py-1 mt-2", style: { backgroundColor: colors.border + "44" } },
                    React.createElement("span", { className: "text-[11px] font-extrabold", style: { color: colors.textMuted } }, letter)),
                grouped[letter].map((c) => (React.createElement(ContactRow, { key: c.id, contact: c, isOnline: isOn(c), blocked: blockedOf(c), colors: colors, onPress: () => setSelectedId(c.id) })))))),
            phoneContacts.length > 0 && (React.createElement("div", null,
                React.createElement("div", { className: "px-4 pt-4 pb-1" },
                    React.createElement("span", { className: "text-[11px] font-extrabold", style: { color: colors.textMuted } }, t("mn_jhat_hatfk"))),
                [...phoneContacts].sort((a, b) => a.name.localeCompare(b.name, "ar")).map((c) => (React.createElement(ContactRow, { key: c.id, contact: c, isOnline: false, colors: colors, onPress: () => setSelectedId(c.id), showInvite: true }))))),
            contacts.length === 0 && (React.createElement("div", { className: "px-6 pt-8 flex flex-col items-center text-center" },
                React.createElement("div", { className: "w-16 h-16 rounded-full flex items-center justify-center mb-3", style: { backgroundColor: colors.primaryLight } },
                    React.createElement(Users, { size: 28, color: colors.primary })),
                React.createElement("div", { className: "text-base font-extrabold mb-1.5", style: { color: colors.text } }, t("ct_none_title")),
                React.createElement("p", { className: "text-xs leading-relaxed mb-4", style: { color: colors.textMuted } }, t("ct_none_desc")),
                React.createElement(Button, { icon: UserPlus, label: t("ct_add_title"), onPress: () => setShowAddModal(true) }))),
            contacts.length > 0 && filtered.length === 0 && (React.createElement(EmptyState, { icon: view === "online" ? Wifi : Search, label: view === "online" && !q ? tl("لا أحد متّصل الآن", "Nobody is online right now") : t("la_twjd_ntayj") }))),
        !search && view === "all" && letters.length > 6 && (React.createElement("div", { className: "absolute top-1/2 flex flex-col gap-0.5", style: { [isRTL() ? "left" : "right"]: 4, transform: "translateY(-50%)", zIndex: 10 } }, letters.map((l) => (React.createElement("button", { key: l, onClick: () => { var _a; (_a = sectionRefs.current[l]) === null || _a === void 0 ? void 0 : _a.scrollIntoView({ behavior: "smooth", block: "start" }); }, className: "w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-extrabold", style: { color: colors.primary } }, l))))),
        React.createElement("button", { "aria-label": t("idafa_mshark"), onClick: () => setShowAddModal(true), className: "absolute flex items-center justify-center rounded-full shadow-lg", style: { bottom: 20, [isRTL() ? "left" : "right"]: 20, width: 52, height: 52, backgroundColor: colors.primary, zIndex: 10 } },
            React.createElement(UserPlus, { size: 22, color: "#fff" })),
        showAddModal && (React.createElement(AddContactSheet, { colors: colors, onClose: () => setShowAddModal(false) })),
        selected && !selected.onSawa && (React.createElement(NonSawaContactSheet, { contact: selected, colors: colors, onClose: close })),
        selected && selected.onSawa && (React.createElement(ContactProfileSheet, { contact: selected, isOnline: isOn(selected), blocked: blockedOf(selected), colors: colors,
            onMessage: () => { onMessageContact(selected); close(); },
            onCall: () => { callReal(selected, "audio"); close(); },
            onVideoCall: () => { callReal(selected, "video"); close(); },
            onSecret: SC && SC.e2eStartDm && SC.e2eSupported && SC.e2eSupported() ? () => { close(); SC.e2eStartDm(selected.uid); } : null,
            onRename: SC && SC.renameContact ? () => { close(); SC.renameContact(selected.uid); } : null,
            onToggleBlock: SC && SC.setBlocked ? () => { const on = !blockedOf(selected); SC.setBlocked(selected.uid, on); bump((x) => x + 1); showToast(on ? tl("حُظر «" + selected.name + "»", "Blocked " + selected.name) : tl("أُلغي حظر «" + selected.name + "»", "Unblocked " + selected.name), "success"); } : null,
            onRemove: SC && SC.removeContact && (selected.via || []).some((v) => v !== "family") && !((selected.via || []).length === 1 && selected.via[0] === "family") ? () => { const n = selected.name; SC.removeContact(selected.uid).then(() => showToast(tl("أُزيل «" + n + "» من جهات اتّصالك", "Removed " + n), "success")); close(); } : null,
            familyOnly: (selected.via || []).indexOf("family") >= 0,
            onReport: SC && SC.reportSheet ? () => { const s0 = selected; close(); SC.reportSheet({ target: s0.uid, name: s0.name, kind: "dm", onBlock: SC.setBlocked ? () => { SC.setBlocked(s0.uid, true); bump((x) => x + 1); } : null }); } : null,
            onClose: close }))));
}
function AddContactModal({ colors, onAdd, onClose }) {
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [error, setError] = useState("");
    function handleSave() {
        if (!name.trim()) {
            setError(t("alasm_mtlwb"));
            return;
        }
        if (!phone.trim()) {
            setError(t("rqm_alhatf_mtlwb"));
            return;
        }
        onAdd({ name: name.trim(), phone: phone.trim() });
    }
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 40 } }),
        React.createElement("div", { className: "absolute left-0 right-0 bottom-0 rounded-t-3xl pt-5 px-5 pb-8", style: { backgroundColor: colors.card, zIndex: 50 } },
            React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto mb-5", style: { backgroundColor: colors.border } }),
            React.createElement("h3", { className: `text-base font-extrabold ${textStart()} mb-4`, style: { color: colors.text } }, t("idafa_jha_atsal")),
            React.createElement("div", { className: "flex flex-col gap-3 mb-4" },
                React.createElement("div", null,
                    React.createElement("label", { className: `text-xs font-bold mb-1 block ${textStart()}`, style: { color: colors.textMuted } }, t("alasm")),
                    React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: name, onChange: (e) => setName(e.target.value), placeholder: t("adkhl_alasm_alkaml"), className: "w-full rounded-xl px-3 py-2.5 text-sm border outline-none", style: { backgroundColor: colors.bg, borderColor: colors.border, color: colors.text, minWidth: 0 } })),
                React.createElement("div", null,
                    React.createElement("label", { className: `text-xs font-bold mb-1 block ${textStart()}`, style: { color: colors.textMuted } }, t("rqm_alhatf")),
                    React.createElement("input", { dir: "ltr", value: phone, onChange: (e) => setPhone(e.target.value), placeholder: "09XXXXXXXX", inputMode: "tel", className: `w-full rounded-xl px-3 py-2.5 text-sm border outline-none ${textStart()}`, style: { backgroundColor: colors.bg, borderColor: colors.border, color: colors.text, minWidth: 0 } }))),
            error && React.createElement("p", { className: "text-xs font-bold text-center mb-3", style: { color: colors.danger } }, error),
            React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                React.createElement(Button, { label: t("hfz"), onPress: handleSave, style: { flex: 1 }, disabled: !name.trim() || !phone.trim() }),
                React.createElement(Button, { label: t("ilgha"), variant: "outline", onPress: onClose, style: { flex: 1 } })))));
}
function ContactRow({ contact, isOnline, blocked, colors, onPress, showInvite }) {
    return (React.createElement("button", { onClick: onPress, className: "w-full flex flex-row items-center px-4 py-2.5 gap-3", style: { backgroundColor: "transparent", opacity: blocked ? 0.6 : 1 } },
        React.createElement("div", { className: "relative shrink-0" },
            React.createElement(Pic, { photo: contact.photo || null, letter: contact.name.charAt(0), size: 44, bg: colors.primaryLight, color: colors.primaryDark }),
            isOnline && !blocked && (React.createElement("span", { className: "absolute bottom-0 w-3 h-3 rounded-full border-2", style: { [isRTL() ? "left" : "right"]: 0, backgroundColor: "#22C55E", borderColor: colors.bg } }))),
        React.createElement("div", { className: `flex-1 ${textStart()}`, style: { minWidth: 0 } },
            React.createElement("div", { className: "text-sm font-bold truncate", style: { color: colors.text } }, contact.name),
            React.createElement("div", { className: "text-xs mt-0.5 truncate", style: { color: blocked ? colors.danger : isOnline ? "#22C55E" : colors.textMuted } }, blocked ? tl("محظور", "Blocked") : contactSubtitle(contact, isOnline))),
        blocked && React.createElement(Ban, { size: 15, color: colors.danger }),
        showInvite && (React.createElement("span", { className: "text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0", style: { backgroundColor: colors.primaryLight, color: colors.primary } }, t("dawa")))));
}
function ContactProfileSheet({ contact, isOnline, blocked, colors, onCall, onVideoCall, onMessage, onSecret, onRename, onToggleBlock, onRemove, familyOnly, onReport, onClose }) {
    const [confirm, setConfirm] = useState(null);   // null | "block" | "remove"
    // C61: الكلمة تحت الدائرة تنقر أيضاً (كان النقر عليها لا يفعل شيئاً)
    const act = (icon, label, onPress, bg) => React.createElement("div", { className: "flex flex-col items-center gap-1.5", style: { opacity: onPress ? 1 : 0.35, cursor: onPress ? "pointer" : "default" }, onClick: onPress || undefined },
        React.createElement("button", { "aria-label": label, onClick: (e) => { e.stopPropagation(); if (onPress) onPress(); }, disabled: !onPress, className: "w-13 h-13 rounded-full flex items-center justify-center", style: { width: 52, height: 52, backgroundColor: bg } }, React.createElement(icon, { size: 21, color: "#fff" })),
        React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.textMuted } }, label));
    const row = (icon, label, sub, onPress, danger) => React.createElement("button", { onClick: onPress, className: "w-full flex flex-row items-center gap-3 px-3 py-3 rounded-xl", style: { backgroundColor: danger ? colors.danger + "0f" : colors.bg } },
        React.createElement(icon, { size: 17, color: danger ? colors.danger : colors.primary }),
        React.createElement("div", { className: `flex-1 ${textStart()}` },
            React.createElement("span", { className: "text-sm font-bold block", style: { color: danger ? colors.danger : colors.text } }, label),
            sub ? React.createElement("span", { className: "text-[10.5px] leading-4 block", style: { color: colors.textMuted } }, sub) : null));
    const ask = (title, text, yes, onYes) => React.createElement("div", { className: "rounded-xl p-3", style: { backgroundColor: colors.danger + "0f", border: `1px solid ${colors.danger}33` } },
        React.createElement("p", { className: "text-sm font-extrabold mb-1", style: { color: colors.text } }, title),
        React.createElement("p", { className: "text-[11.5px] leading-5 mb-3", style: { color: colors.textMuted } }, text),
        React.createElement("div", { className: "flex flex-row gap-2" },
            React.createElement("button", { onClick: () => { setConfirm(null); onYes(); }, className: "flex-1 py-2.5 rounded-xl text-sm font-extrabold text-white", style: { backgroundColor: colors.danger } }, yes),
            React.createElement("button", { onClick: () => setConfirm(null), className: "flex-1 py-2.5 rounded-xl text-sm font-bold", style: { backgroundColor: colors.card, color: colors.text, border: `1px solid ${colors.border}` } }, tl("إلغاء", "Cancel"))));
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 40 } }),
        React.createElement("div", { className: "absolute left-0 right-0 bottom-0 rounded-t-3xl pb-6 pt-3 px-5 overflow-y-auto", style: { backgroundColor: colors.card, zIndex: 50, maxHeight: "92%" } },
            React.createElement("div", { className: "flex flex-row items-center justify-between mb-1" },
                React.createElement("div", { style: { width: 36 } }),
                React.createElement("div", { className: "w-10 h-1 rounded-full", style: { backgroundColor: colors.border } }),
                React.createElement("button", { "aria-label": tl("إغلاق", "Close"), onClick: onClose, className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.bg } }, React.createElement(X, { size: 16, color: colors.textMuted }))),
            React.createElement("div", { className: "flex flex-col items-center mb-4" },
                React.createElement("div", { className: "relative mb-2.5" },
                    React.createElement(Pic, { photo: contact.photo || null, letter: contact.name.charAt(0), size: 80, bg: colors.primaryLight, color: colors.primaryDark }),
                    isOnline && !blocked && (React.createElement("span", { className: "absolute bottom-1 w-4 h-4 rounded-full border-2", style: { [isRTL() ? "left" : "right"]: 4, backgroundColor: "#22C55E", borderColor: colors.card } }))),
                React.createElement("span", { className: "text-lg font-extrabold text-center", style: { color: colors.text } }, contact.name),
                contact.nick && contact.realName && contact.realName !== contact.nick && React.createElement("span", { className: "text-[11px] mt-0.5", style: { color: colors.textMuted } }, tl("اسمه في سوا: ", "Sawa name: ") + contact.realName),
                React.createElement("span", { className: "text-xs mt-1", style: { color: blocked ? colors.danger : isOnline ? "#22C55E" : colors.textMuted } }, blocked ? tl("🚫 محظور — لا تصلك رسائله ولا مكالماته", "🚫 Blocked") : contactSubtitle(contact, isOnline)),
                contact.families && contact.families.length > 0 && React.createElement("span", { className: "text-[11px] mt-0.5 text-center", style: { color: colors.textMuted } }, contact.families.map((f) => f.name).join(" · "))),
            React.createElement("div", { className: "flex flex-row justify-center gap-5 mb-5" },
                act(MessageCircle, t("rsala"), blocked ? null : onMessage, colors.primary),
                act(Phone, t("atsal"), blocked ? null : onCall, colors.success || "#22C55E"),
                act(Video, t("fydyw"), blocked ? null : onVideoCall, colors.accent || "#8B5CF6"),
                onSecret && act(Lock, tl("سرّيّة", "Secret"), blocked ? null : onSecret, "#16a34a")),
            confirm === "block" ? ask(tl("حظر «" + contact.name + "»؟", "Block " + contact.name + "?"), tl("لن تصلك رسائله ولا مكالماته، ولن يعرف أنّك حظرته. يمكنك إلغاء الحظر في أيّ وقت.", "You won't get their messages or calls, and they won't be told. You can unblock anytime."), tl("حظر", "Block"), onToggleBlock)
                : confirm === "remove" ? ask(tl("إزالة «" + contact.name + "» من جهات اتّصالك؟", "Remove " + contact.name + "?"), tl("لن يرى حالتك ولن يستطيع الاتّصال بك. محادثتكما السابقة تبقى عندك. ليعود يحتاج رمزك أو رابطك من جديد.", "They won't see your status or be able to call you. Your chat stays. To reconnect they'll need your code or link again."), tl("إزالة", "Remove"), onRemove)
                : React.createElement("div", { className: "flex flex-col gap-2" },
                    onRename && row(Edit3, contact.nick ? tl("تعديل التسمية", "Edit name") : tl("تسمية", "Set a name"), tl("اسمٌ تختاره يظهر لك وحدك", "A name only you see"), onRename),
                    onToggleBlock && (blocked ? row(Ban, tl("إلغاء الحظر", "Unblock"), null, onToggleBlock) : row(Ban, tl("حظر", "Block"), tl("لا تصلك رسائله ولا مكالماته", "No messages or calls from them"), () => setConfirm("block"), true)),
                    onRemove ? row(Trash2, t("ct_remove"), null, () => setConfirm("remove"), true)
                        : familyOnly ? React.createElement("p", { className: "text-[10.5px] text-center px-2", style: { color: colors.textMuted } }, tl("من عائلةٍ مشتركة — يبقى في جهات اتّصالك ما دمتما في العائلة نفسها.", "From a shared family — stays while you're both in it.")) : null,
                    onReport && row(Flag, tl("إبلاغ", "Report"), null, onReport, true)))));
}
// إضافة جهة اتّصال (C1): رابطٌ شخصيّ · رمز QR · مسح رمز · لصق رابط — كلّها عبر SawaChat
function AddContactSheet({ colors, onClose }) {
    const SC = window.SawaChat;
    const qrRef = useRef(null);
    const [qrShown, setQrShown] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pasted, setPasted] = useState("");
    function showQr() {
        if (!SC || !qrRef.current) return;
        setQrShown(true); setBusy(true);
        SC.renderQr(qrRef.current, 200).catch((e) => { if (qrRef.current) qrRef.current.textContent = (e && e.message) || String(e); }).then(() => setBusy(false));
    }
    function scan() { if (SC) SC.scanAndAdd().then((r) => { if (r) onClose(); }); }
    function addPasted() { if (SC && pasted.trim()) SC.accept(pasted.trim()).then((r) => { if (r) onClose(); }); }
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 40 } }),
        React.createElement("div", { className: "absolute left-0 right-0 bottom-0 rounded-t-3xl pt-5 px-5 pb-8 overflow-y-auto", style: { backgroundColor: colors.card, zIndex: 50, maxHeight: "92%" } },
            React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto mb-4", style: { backgroundColor: colors.border } }),
            React.createElement("h3", { className: `text-base font-extrabold ${textStart()} mb-1.5`, style: { color: colors.text } }, t("ct_add_title")),
            React.createElement("p", { className: `text-xs leading-relaxed ${textStart()} mb-4`, style: { color: colors.textMuted } }, t("ct_add_desc")),
            // C10: الأسهل — رمز سوا (١٠ أرقام) بطلب تواصلٍ يوافق عليه صاحبه
            SC && SC.findSheet && React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-2.5` },
                React.createElement("button", { onClick: () => { onClose(); SC.findSheet(); }, className: "flex-1 rounded-xl py-2.5 text-sm font-extrabold", style: { backgroundColor: colors.primary, color: "#fff" } }, tl("🔢 أدخل رمز شخص", "🔢 Enter a code")),
                React.createElement("button", { onClick: () => { onClose(); SC.codeSheet(); }, className: "flex-1 rounded-xl py-2.5 text-sm font-bold border", style: { borderColor: colors.primary, color: colors.primary } }, tl("رمزي", "My code"))),
            React.createElement(Button, { icon: Share2, label: t("ct_share_link"), onPress: () => SC && SC.shareInvite() }),
            React.createElement("button", { onClick: showQr, className: `w-full mt-2.5 flex ${rowStart()} items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold border`, style: { borderColor: colors.primary, color: colors.primary } }, t("ct_show_qr")),
            React.createElement("div", { className: "flex flex-col items-center", style: { display: qrShown ? "flex" : "none" } },
                // ⛔ عنصر الرمز بلا أبناء React: مكتبة QR تكتب داخله مباشرةً، وأيّ ابنٍ يديره React (مثل «…») كان
                //    يُمحى عند إعادة الرسم فيختفي الرمز فور ظهوره
                busy && React.createElement("div", { className: "mt-3 text-xs", style: { color: colors.textMuted } }, "…"),
                React.createElement("div", { className: "mt-3 p-2 rounded-xl", style: { backgroundColor: "#fff", display: busy ? "none" : "block" } },
                    React.createElement("div", { ref: qrRef, style: { width: 200, height: 200, color: "#666", fontSize: 12 } })),
                React.createElement("p", { className: "text-[10px] mt-2 text-center", style: { color: colors.textMuted } }, t("ct_qr_hint"))),
            SC && SC.scanSupported() && React.createElement("button", { onClick: scan, className: `w-full mt-2.5 flex ${rowStart()} items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold border`, style: { borderColor: colors.border, color: colors.text } }, t("ct_scan_qr")),
            React.createElement("div", { className: `flex ${rowStart()} gap-2 mt-3` },
                React.createElement("input", { dir: "ltr", value: pasted, onChange: (e) => setPasted(e.target.value), placeholder: t("ct_paste_ph"), className: "flex-1 rounded-xl px-3 py-2.5 text-xs border outline-none", style: { backgroundColor: colors.bg, borderColor: colors.border, color: colors.text } }),
                React.createElement("button", { onClick: addPasted, disabled: !pasted.trim(), className: "rounded-xl px-4 text-xs font-bold", style: { backgroundColor: pasted.trim() ? colors.primary : colors.border, color: "#fff" } }, t("ct_add_btn"))))));
}

// جهة اتصال غير مسجّلة على سوا — لا محادثة ولا مكالمة داخل التطبيق.
// المتاح: اتصال عادي من شبكة الهاتف، ودعوة عبر SMS.
function NonSawaContactSheet({ contact, colors, onClose }) {
    const phone = (contact && contact.phone) || "";
    const inviteText = "تعال نتواصل على سوا — " + SAWA_INVITE_URL;
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 40 } }),
        React.createElement("div", { className: "absolute left-0 right-0 bottom-0 rounded-t-3xl pb-8 pt-5 px-6", style: { backgroundColor: colors.card, zIndex: 50 } },
            React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto mb-5", style: { backgroundColor: colors.border } }),
            React.createElement("div", { className: "flex flex-col items-center mb-5" },
                React.createElement("div", { className: "w-20 h-20 rounded-full flex items-center justify-center font-extrabold text-3xl mb-3", style: { backgroundColor: colors.border, color: colors.textMuted } }, (contact.name || "?").charAt(0)),
                React.createElement("span", { className: "text-lg font-extrabold", style: { color: colors.text } }, contact.name),
                React.createElement("span", { className: "text-sm mt-0.5", style: { color: colors.textMuted } }, phone),
                React.createElement("span", { className: "text-[11px] font-bold mt-1.5", style: { color: colors.textMuted } }, t("cs_ghyr_msjl"))),
            React.createElement("div", { className: `flex ${rowStart()} justify-center gap-6 mb-5` },
                React.createElement("div", { className: "flex flex-col items-center gap-1.5" },
                    React.createElement("a", { href: "tel:" + phone, className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: "#22C55E" } },
                        React.createElement(Phone, { size: 22, color: "#fff" })),
                    React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.textMuted } }, t("cs_atsal"))),
                React.createElement("div", { className: "flex flex-col items-center gap-1.5" },
                    React.createElement("a", { href: "sms:" + phone + "?body=" + encodeURIComponent(inviteText), className: "w-14 h-14 rounded-full flex items-center justify-center", style: { backgroundColor: colors.primary } },
                        React.createElement(MessageCircle, { size: 22, color: "#fff" })),
                    React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.textMuted } }, t("cs_rsala_sms")))),
            React.createElement("a", { href: "sms:" + phone + "?body=" + encodeURIComponent(inviteText), className: "w-full flex flex-row items-center justify-center gap-2 rounded-2xl py-3.5", style: { backgroundColor: colors.primary } },
                React.createElement(UserPlus, { size: 17, color: "#fff" }),
                React.createElement("span", { className: "text-sm font-extrabold", style: { color: "#fff" } }, t("cs_dawa_ila_swa"))))));
}
// ============================================================================
// أقصى طول للحظة الواحدة — يمنع نصاً بلا نهاية يكسر البطاقة
const MOMENT_MAX_CHARS = 500;
// لحظات الأصدقاء (Moments) — أول خدمة مصغّرة بتبويب استكشف بسوا الأصلي
// ============================================================================
// نطاق وحدة: labelKey لا label (انظر ملاحظة tabs)
const privacyOptions = [
    { key: "public", labelKey: "khsw_alkl", icon: Globe },
    { key: "close", labelKey: "khsw_asdqa_mqrbwn", icon: Users },
    { key: "private", labelKey: "khsw_ana_fqt", icon: Lock },
];
// يصغّر الصورة قبل حفظها — بدونه تمتلئ مساحة التخزين بعد صور قليلة
function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onerror = function () { reject(new Error("read")); };
        reader.onload = function () {
            const img = new window.Image();
            img.onerror = function () { reject(new Error("decode")); };
            img.onload = function () {
                let w = img.width, h = img.height;
                const scale = Math.min(1, maxSide / Math.max(w, h));
                w = Math.round(w * scale); h = Math.round(h * scale);
                const canvas = document.createElement("canvas");
                canvas.width = w; canvas.height = h;
                canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                try { resolve(canvas.toDataURL("image/jpeg", quality)); }
                catch (e) { reject(e); }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
// وقت نسبي مختصر — يتبع اللغة
function momentTimeAgo(ts) {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("wqt_alan");
    if (mins < 60) return t("qbl_d", { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("qbl_s", { n: hours });
    const days = Math.floor(hours / 24);
    if (days === 1) return t("wqt_ams");
    if (days < 7) return t("qbl_ayam", { n: days });
    return new Date(ts).toLocaleDateString(loc(), { day: "numeric", month: "short" });
}
// ما تبقّى من عمر لحظة مؤقتة
function momentRemaining(expiresAt) {
    const left = expiresAt - Date.now();
    if (left <= 0) return null;
    const hours = Math.floor(left / 3600000);
    if (hours >= 1) return t("ytbqa_s", { n: hours });
    return t("ytbqa_d", { n: Math.max(1, Math.floor(left / 60000)) });
}
function MomentsScreen({ posts, myUserId, onAddPost, onToggleLike, onAddComment, onDeletePost, onViewPost, onReplyPrivately, onVotePoll, onBack }) {
    const { colors } = useTheme();
    const [text, setText] = useState("");
    const [privacy, setPrivacy] = useState("public");
    const [photoFile, setPhotoFile] = useState(null);
    const [photoData, setPhotoData] = useState(null);
    const [photoBusy, setPhotoBusy] = useState(false);
    const [composerOpen, setComposerOpen] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState(null);
    const [viewingPhoto, setViewingPhoto] = useState(null);
    const [sharedLocation, setSharedLocation] = useState(null);
    const [isTimed, setIsTimed] = useState(false);
    const [commentDrafts, setCommentDrafts] = useState({});
    const [openComments, setOpenComments] = useState({});
    const photoInputRef = useRef(null);
    const viewedThisSessionRef = useRef(new Set());
    const [viewingLocation, setViewingLocation] = useState(null);
    const [showPollSticker, setShowPollSticker] = useState(false);
    const [pollStickerQuestion, setPollStickerQuestion] = useState("");
    const [pollStickerOptions, setPollStickerOptions] = useState(["", ""]);
    const [replyingPrivatelyTo, setReplyingPrivatelyTo] = useState(null);
    const [privateReplyDraft, setPrivateReplyDraft] = useState("");
    const [nowTick, setNowTick] = useState(Date.now());
    useEffect(() => {
        // نتحقق كل 30 ثانية من وجود لحظات انتهت صلاحيتها — يضمن اختفاءها
        // فعلياً بلحظة الانتهاء، مو بس عرض شارة "مؤقت" بلا أثر حقيقي
        const interval = setInterval(() => setNowTick(Date.now()), 30000);
        return () => clearInterval(interval);
    }, []);
    const visiblePosts = posts.filter((p) => !p.expiresAt || p.expiresAt > nowTick);
    useEffect(() => {
        posts.forEach((p) => {
            if (p.authorId !== myUserId && !viewedThisSessionRef.current.has(p.id)) {
                viewedThisSessionRef.current.add(p.id);
                onViewPost(p.id);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [posts.map((p) => p.id).join(",")]);
    function handlePublish() {
        if (!text.trim() && !photoData)
            return;
        const validPollOptions = pollStickerOptions.filter((o) => o.trim());
        const pollSticker = (showPollSticker && pollStickerQuestion.trim() && validPollOptions.length >= 2)
            ? { question: pollStickerQuestion.trim(), options: validPollOptions.map((opt) => ({ text: opt.trim(), votes: [] })) }
            : null;
        onAddPost({
            text: text.trim(),
            privacy,
            photoName: (photoFile === null || photoFile === void 0 ? void 0 : photoFile.name) || null,
            location: sharedLocation,
            photoData: photoData,
            expiresAt: isTimed ? Date.now() + 24 * 60 * 60 * 1000 : null,
            pollSticker,
        });
        setText("");
        setComposerOpen(false);
        setPhotoData(null);
        setPhotoFile(null);
        setSharedLocation(null);
        setIsTimed(false);
        setShowPollSticker(false);
        setPollStickerQuestion("");
        setPollStickerOptions(["", ""]);
    }
    return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col relative" },
        React.createElement(TopBar, { title: t("lhzat_alasdqa"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            !composerOpen && React.createElement("button", { onClick: () => setComposerOpen(true), className: `w-full flex ${rowStart()} items-center gap-2 rounded-2xl px-4 py-3 border mb-3`, style: { backgroundColor: colors.card, borderColor: colors.border } },
                React.createElement("div", { className: "w-8 h-8 rounded-full flex items-center justify-center shrink-0", style: { backgroundColor: colors.primaryLight } },
                    React.createElement(Plus, { size: 16, color: colors.primary })),
                React.createElement("span", { className: `flex-1 text-sm ${textStart()}`, style: { color: colors.textMuted } }, t("shark_khatra")),
                React.createElement(Image, { size: 15, color: colors.textMuted, className: "shrink-0" })),
            composerOpen && React.createElement(Card, null,
                React.createElement("div", { className: "flex items-center justify-end mb-1" },
                    React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => { setComposerOpen(false); setPhotoData(null); setPhotoFile(null); } },
                        React.createElement(X, { size: 15, color: colors.textMuted }))),
                React.createElement("textarea", { value: text, maxLength: MOMENT_MAX_CHARS, onChange: (e) => setText(e.target.value.slice(0, MOMENT_MAX_CHARS)), placeholder: t("shark_khatra"), className: "w-full border rounded-xl px-3 py-2 text-sm resize-none", rows: 2, style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                // عدّاد الأحرف — يظهر عند الاقتراب من الحد فقط حتى لا يزحم الواجهة
                React.createElement("div", { className: "flex justify-end mb-2", style: { minHeight: 14 } },
                    text.length >= MOMENT_MAX_CHARS - 60 && React.createElement("span", { dir: "ltr", className: "text-[10px] font-bold", style: { color: text.length >= MOMENT_MAX_CHARS ? colors.danger : colors.textMuted } }, text.length + " / " + MOMENT_MAX_CHARS)),
                React.createElement("input", { ref: photoInputRef, type: "file", accept: "image/*", className: "hidden", onChange: function (e) {
                    const f = e.target.files && e.target.files[0];
                    if (!f) { setPhotoFile(null); setPhotoData(null); return; }
                    setPhotoFile(f); setPhotoBusy(true);
                    compressImage(f, 800, 0.72)
                        .then(function (data) { setPhotoData(data); })
                        .catch(function () { setPhotoData(null); })
                        .then(function () { setPhotoBusy(false); });
                } }),
                React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 mb-2 overflow-x-auto`, style: { scrollbarWidth: "none" } },
                    React.createElement("button", { onClick: () => { var _a; return (_a = photoInputRef.current) === null || _a === void 0 ? void 0 : _a.click(); }, className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1 shrink-0 whitespace-nowrap`, style: { borderColor: photoFile ? colors.success : colors.border } },
                        React.createElement(Image, { size: 13, color: photoData ? colors.success : colors.textMuted }),
                        React.createElement("span", { className: "text-[10px] font-bold", style: { color: photoData ? colors.success : colors.textMuted } }, photoBusy ? t("mo_jary_altjhyz") : photoData ? t("mo_swra_jahza") : t("mo_swra"))),
                    React.createElement("button", { onClick: () => setSharedLocation((prev) => (prev ? null : { x: 45, y: 60 })), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1 shrink-0 whitespace-nowrap`, style: { borderColor: sharedLocation ? colors.success : colors.border } },
                        React.createElement(MapPin, { size: 13, color: sharedLocation ? colors.success : colors.textMuted }),
                        React.createElement("span", { className: "text-[10px] font-bold", style: { color: sharedLocation ? colors.success : colors.textMuted } }, t("mwqay"))),
                    React.createElement("button", { onClick: () => setIsTimed(!isTimed), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1 shrink-0 whitespace-nowrap`, style: { borderColor: isTimed ? colors.accent : colors.border } },
                        React.createElement(Clock, { size: 13, color: isTimed ? colors.accent : colors.textMuted }),
                        React.createElement("span", { className: "text-[10px] font-bold", style: { color: isTimed ? colors.accent : colors.textMuted } }, t("tkhtfy_bad_24_saaa"))),
                    React.createElement("button", { onClick: () => setShowPollSticker(!showPollSticker), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1 shrink-0 whitespace-nowrap`, style: { borderColor: showPollSticker ? colors.primary : colors.border } },
                        React.createElement(BarChart3, { size: 13, color: showPollSticker ? colors.primary : colors.textMuted }),
                        React.createElement("span", { className: "text-[10px] font-bold", style: { color: showPollSticker ? colors.primary : colors.textMuted } }, t("asttlaa")))),
                showPollSticker && (React.createElement("div", { className: "rounded-xl border p-2.5 mb-2", style: { borderColor: colors.primary, backgroundColor: colors.primaryLight } },
                    React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: pollStickerQuestion, onChange: (e) => setPollStickerQuestion(e.target.value), placeholder: t("swal_alasttlaa"), className: "w-full border rounded-xl px-2.5 py-1.5 text-xs mb-1.5", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                    React.createElement("div", { className: `flex ${rowStart()} gap-1.5` },
                        React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: pollStickerOptions[0], onChange: (e) => setPollStickerOptions([e.target.value, pollStickerOptions[1]]), placeholder: t("khyar_1"), className: "flex-1 border rounded-xl px-2.5 py-1.5 text-xs", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card, minWidth: 0 } }),
                        React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: pollStickerOptions[1], onChange: (e) => setPollStickerOptions([pollStickerOptions[0], e.target.value]), placeholder: t("khyar_2"), className: "flex-1 border rounded-xl px-2.5 py-1.5 text-xs", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card, minWidth: 0 } })))),
                photoData && React.createElement("div", { className: "relative rounded-xl overflow-hidden mb-2", style: { border: `1px solid ${colors.border}` } },
                    React.createElement("img", { src: photoData, alt: "صورة", style: { width: "100%", maxHeight: 220, objectFit: "cover", display: "block" } }),
                    React.createElement("button", { "aria-label": t("hdhf"), onClick: () => { setPhotoData(null); setPhotoFile(null); }, className: "absolute top-2 left-2 w-7 h-7 rounded-full flex items-center justify-center", style: { backgroundColor: "rgba(0,0,0,0.55)" } },
                        React.createElement(X, { size: 14, color: "#fff" }))),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-2` }, privacyOptions.map((p) => React.createElement(Chip, { key: p.key, label: t(p.labelKey), active: privacy === p.key, onPress: () => setPrivacy(p.key) }))),
                React.createElement(Button, { label: t("nshr"), onPress: handlePublish, disabled: photoBusy || (!text.trim() && !photoData) })),
            visiblePosts.length === 0 && React.createElement(EmptyState, { icon: Image, label: t("la_twjd_lhzat_mnshwra") }),
            visiblePosts.map((p) => {
                var _a;
                return (React.createElement(Card, { key: p.id },
                    React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-1.5` },
                        React.createElement("div", { className: `flex ${rowStart()} items-center gap-2` },
                            React.createElement("span", { className: "text-sm font-bold", style: { color: colors.text } }, p.author),
                            React.createElement(Badge, { size: "sm", variant: "neutral", label: (_a = privacyOptions.find((o) => o.key === p.privacy)) ? t(_a.labelKey) : undefined }),
                            p.createdAt && React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } }, momentTimeAgo(p.createdAt)),
                            p.expiresAt && React.createElement(Badge, { size: "sm", variant: "warning", icon: Clock, label: momentRemaining(p.expiresAt) || t("mwqt") })),
                        p.authorId === myUserId && (React.createElement("button", { "aria-label": t("hdhf"), onClick: () => setConfirmDeleteId(p.id) },
                            React.createElement(Trash2, { size: 14, color: colors.danger })))),
                    p.photoData
                        ? React.createElement("button", { onClick: () => setViewingPhoto(p.photoData), className: "block w-full rounded-xl overflow-hidden mb-2", style: { border: `1px solid ${colors.border}` } },
                            React.createElement("img", { src: p.photoData, alt: p.photoName || "صورة", loading: "lazy", style: { width: "100%", maxHeight: 300, objectFit: "cover", display: "block" } }))
                        : (p.photoName && React.createElement("div", { className: `rounded-xl border flex ${rowStart()} items-center gap-2 p-2 mb-2`, style: { borderColor: colors.border, backgroundColor: colors.bg } },
                            React.createElement(Image, { size: 16, color: colors.textMuted }),
                            React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } }, "الصورة لم تعد محفوظة على هذا الجهاز"))),
                    !!p.text && React.createElement("p", { className: "text-sm mb-2", style: { color: colors.text } }, p.text),
                    p.pollSticker && (() => {
                        const totalVotes = p.pollSticker.options.reduce((s, o) => s + o.votes.length, 0);
                        const myVote = p.pollSticker.options.findIndex((o) => o.votes.includes(myUserId));
                        return (React.createElement("div", { className: "rounded-xl border p-2.5 mb-3", style: { borderColor: colors.primary, backgroundColor: colors.primaryLight } },
                            React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 mb-1.5` },
                                React.createElement(BarChart3, { size: 13, color: colors.primary }),
                                React.createElement("span", { className: "text-xs font-bold", style: { color: colors.text } }, p.pollSticker.question)),
                            p.pollSticker.options.map((opt, i) => {
                                const pct = totalVotes > 0 ? Math.round((opt.votes.length / totalVotes) * 100) : 0;
                                return (React.createElement("button", { key: i, onClick: () => onVotePoll(p.id, i), className: `w-full ${textStart()} mb-1` },
                                    React.createElement("div", { className: `flex ${rowStart()} justify-between text-[10px] mb-0.5`, style: { color: myVote === i ? colors.primary : colors.text } },
                                        React.createElement("span", null,
                                            opt.text,
                                            myVote === i ? " ✓" : ""),
                                        React.createElement("span", null,
                                            pct,
                                            "%")),
                                    React.createElement("div", { className: "h-1.5 rounded-full", style: { backgroundColor: colors.card } },
                                        React.createElement("div", { className: "h-1.5 rounded-full", style: { width: `${pct}%`, backgroundColor: colors.primary } }))));
                            })));
                    })(),
                    p.location && (React.createElement("button", { onClick: () => setViewingLocation(p.location), className: "text-[11px] font-bold underline mb-3 block", style: { color: colors.primary } }, t("ard_almwqa_ala_alkhryta"))),
                    React.createElement("div", { className: `flex ${rowStart()} items-center gap-3 pt-2.5 border-t flex-wrap`, style: { borderColor: colors.border } },
                        React.createElement("button", { onClick: () => onToggleLike(p.id), className: `flex ${rowStart()} items-center gap-1.5` },
                            React.createElement(Heart, { size: 14, color: p.likedByMe ? colors.danger : colors.textMuted, fill: p.likedByMe ? colors.danger : "none" }),
                            React.createElement("span", { className: "text-xs", style: { color: p.likedByMe ? colors.danger : colors.textMuted } }, p.likes > 0 ? p.likes : "إعجاب")),
                        React.createElement("button", { "aria-label": t("aldrdsha"), onClick: () => setOpenComments((prev) => ({ ...prev, [p.id]: !prev[p.id] })), className: `flex ${rowStart()} items-center gap-1.5` },
                            React.createElement(MessageCircle, { size: 14, color: colors.textMuted }),
                            React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, (p.comments || []).length > 0 ? p.comments.length : t("talyq"))),
                        React.createElement("button", { "aria-label": t("msharka"), onClick: async () => {
                                const text = `لحظة من سوا${p.author ? ` — ${p.author}` : ""}\n${p.text || ""}`;
                                if (navigator.share) {
                                    try {
                                        await navigator.share({ text });
                                    }
                                    catch (err) { }
                                }
                                else {
                                    await copyText(text);
                                }
                            }, className: `flex ${rowStart()} items-center gap-1.5` },
                            React.createElement(Share2, { size: 14, color: colors.textMuted })),
                        p.authorId !== myUserId && (React.createElement("button", { "aria-label": t("irsal"), onClick: () => setReplyingPrivatelyTo((prev) => (prev === p.id ? null : p.id)), className: `flex ${rowStart()} items-center gap-1.5` },
                            React.createElement(Send, { size: 13, color: colors.textMuted, style: { transform: "scaleX(-1)" } }))),
                        React.createElement("div", { className: `flex ${rowStart()} items-center gap-1` },
                            React.createElement(Eye, { size: 12, color: colors.textMuted }),
                            React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } }, p.views || 0))),
                    replyingPrivatelyTo === p.id && (React.createElement("div", { className: `mt-3 pt-3 border-t flex ${rowStart()} items-center gap-2`, style: { borderColor: colors.border } },
                        React.createElement("input", { value: privateReplyDraft, onChange: (e) => setPrivateReplyDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && privateReplyDraft.trim()) {
                                onReplyPrivately(p, privateReplyDraft.trim());
                                setPrivateReplyDraft("");
                                setReplyingPrivatelyTo(null);
                            } }, dir: isRTL() ? "rtl" : "ltr", placeholder: t("rd_khas_ala", { author: p.author }), autoFocus: true, className: "flex-1 rounded-full px-3 py-1.5 text-xs border", style: { borderColor: colors.primary, backgroundColor: colors.bg, color: colors.text } }),
                        React.createElement("button", { onClick: () => { if (privateReplyDraft.trim()) {
                                onReplyPrivately(p, privateReplyDraft.trim());
                                setPrivateReplyDraft("");
                                setReplyingPrivatelyTo(null);
                            } }, className: "text-xs font-bold", style: { color: colors.primary } }, t("irsal")))),
                    openComments[p.id] && (React.createElement("div", { className: "mt-3 pt-3 border-t", style: { borderColor: colors.border } },
                        (p.comments || []).map((c, i) => (React.createElement("div", { key: i, className: "text-xs mb-1", style: { color: colors.text } },
                            React.createElement("b", null, c.author),
                            " ",
                            c.text))),
                        React.createElement("div", { className: `flex ${rowStart()} items-center gap-2 mt-1.5` },
                            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: commentDrafts[p.id] || "", onChange: (e) => setCommentDrafts((prev) => ({ ...prev, [p.id]: e.target.value })), onKeyDown: (e) => { var _a; if (e.key === "Enter" && ((_a = commentDrafts[p.id]) === null || _a === void 0 ? void 0 : _a.trim())) {
                                    onAddComment(p.id, commentDrafts[p.id].trim());
                                    setCommentDrafts((prev) => ({ ...prev, [p.id]: "" }));
                                } }, placeholder: t("adf_talyqa"), className: "flex-1 rounded-full px-3 py-1.5 text-xs border", style: { borderColor: colors.border, backgroundColor: colors.bg, color: colors.text } }),
                            React.createElement("button", { onClick: () => { var _a; if ((_a = commentDrafts[p.id]) === null || _a === void 0 ? void 0 : _a.trim()) {
                                    onAddComment(p.id, commentDrafts[p.id].trim());
                                    setCommentDrafts((prev) => ({ ...prev, [p.id]: "" }));
                                } }, className: "text-xs font-bold", style: { color: colors.primary } }, t("irsal")))))));
            })),
        viewingLocation && (React.createElement("div", { className: "absolute inset-0 z-50 flex flex-col", style: { backgroundColor: colors.bg } },
            React.createElement(TopBar, { title: t("mwqa_allhza"), onBack: () => setViewingLocation(null) }),
            React.createElement("div", { className: "flex-1 p-4" },
                React.createElement("svg", { viewBox: "0 0 100 100", className: "w-full rounded-xl", style: { height: 300, backgroundColor: colors.card, border: `1px solid ${colors.border}` } },
                    [15, 35, 55, 75].map((v) => (React.createElement(React.Fragment, { key: v },
                        React.createElement("line", { x1: v, y1: "0", x2: v, y2: "100", stroke: colors.border, strokeWidth: "0.6" }),
                        React.createElement("line", { x1: "0", y1: v, x2: "100", y2: v, stroke: colors.border, strokeWidth: "0.6" })))),
                    React.createElement("g", { transform: `translate(${viewingLocation.x}, ${viewingLocation.y})` },
                        React.createElement("circle", { r: "3.5", fill: colors.danger }),
                        React.createElement("circle", { r: "1.4", fill: "#fff" })))))),
        viewingPhoto && (React.createElement("div", { onClick: () => setViewingPhoto(null), className: "absolute inset-0 z-50 flex items-center justify-center p-4", style: { backgroundColor: "rgba(0,0,0,0.92)" } },
            React.createElement("img", { src: viewingPhoto, alt: t("swra_mkbra"), style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 12 } }),
            React.createElement("button", { "aria-label": t("ighlaq"), onClick: () => setViewingPhoto(null), className: "absolute top-4 left-4 w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: "rgba(255,255,255,0.15)" } },
                React.createElement(X, { size: 18, color: "#fff" })))),
        confirmDeleteId && (React.createElement(React.Fragment, null,
            React.createElement("div", { onClick: () => setConfirmDeleteId(null), style: { position: "fixed", inset: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.35)" } }),
            React.createElement("div", { className: "sawa-pop-in", style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 41, backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 12 } },
                React.createElement("div", { className: "w-10 h-1 rounded-full mx-auto my-3", style: { backgroundColor: colors.border } }),
                React.createElement("p", { className: "text-sm font-extrabold text-center px-5", style: { color: colors.text } }, "حذف هذه اللحظة؟"),
                React.createElement("p", { className: "text-[11px] text-center mt-1 mb-3 px-5", style: { color: colors.textMuted } }, t("takyd_alhdhf_ma_ynrja")),
                React.createElement("button", { onClick: () => { onDeletePost(confirmDeleteId); setConfirmDeleteId(null); }, className: "w-full px-5 py-3.5 border-t", style: { borderColor: colors.border } },
                    React.createElement("span", { className: "text-sm font-extrabold", style: { color: colors.danger } }, t("nam_ahdhf"))),
                React.createElement("button", { onClick: () => setConfirmDeleteId(null), className: "w-full px-5 py-3.5 border-t", style: { borderColor: colors.border } },
                    React.createElement("span", { className: "text-sm font-bold", style: { color: colors.textMuted } }, t("ilgha"))))))));
}
// ============================================================================
// إرسال إكسبريس (Ersal) — خدمة شحن مصغّرة بتبويب استكشف بسوا الأصلي
// ============================================================================
// ============================================================================
// إرسال إكسبريس — بيانات حقيقية مستخرجة من الكود الأصلي بالضبط (مو أمثلة وهمية)
// ============================================================================
// نطاق وحدة: مفتاح لا نصّ مترجَم (t() هنا تتجمّد على لغة الإقلاع)
const ERSAL_ORIGIN_CITY_KEY = "er_alkhrtwm";
const ERSAL_BASE_PRICE = 15000; // سعر أساسي ثابت لكل شحنة
const ERSAL_WEIGHT_FEE_PER_KG = 25; // 25 ج.س لكل كيلوجرام — تحقّقنا حسابياً من المثال الرسمي (480كجم × 25 = 12,000)
const ERSAL_INSURANCE_RATE = 0.02; // 2٪ من القيمة المُصرَّح بها — رسم تأمين اختياري
const ERSAL_DELIVERY_WINDOWS = [
    { key: "morning", label: t("er_w1") },
    { key: "noon", label: t("er_w2") },
    { key: "afternoon", label: t("er_w3") },
    { key: "evening", label: t("er_w4") },
];
const ERSAL_CITIES = [
    { name: t("er_mdny"), zone: t("er_mntqa_1"), fee: 4000, x: 62, y: 62 },
    { name: t("er_shndy"), zone: t("er_mntqa_1"), fee: 4500, x: 55, y: 22 },
    { name: t("er_atbra"), zone: t("er_mntqa_2"), fee: 7000, x: 58, y: 10 },
    { name: t("er_snar"), zone: t("er_mntqa_2"), fee: 6500, x: 66, y: 78 },
    { name: t("er_kwsty"), zone: t("er_mntqa_2"), fee: 7500, x: 40, y: 72 },
    { name: t("er_alabyd"), zone: t("er_mntqa_3"), fee: 11000, x: 15, y: 65 },
    { name: t("er_bwrtswdan"), zone: t("er_mntqa_3"), fee: 13000, x: 92, y: 8 },
];
const ERSAL_ORIGIN_POINT = { x: 50, y: 45 }; // نقطة الانطلاق التمثيلية — الخرطوم، أصل كل شحنات إرسال
const ERSAL_SHIPMENT_TYPES = [
    { key: "documents", label: t("er_mstndat"), surcharge: 0, icon: FileText },
    { key: "parcel", label: t("er_trd_aady"), surcharge: 0, icon: Package },
    { key: "electronics", label: t("er_ilktrwnyat"), surcharge: 3000, icon: Zap },
    { key: "medicine", label: t("er_adwya"), surcharge: 1500, icon: Stethoscope },
];
// حالة الشحنة — متعددة الاختيار (Multi-select) حسب المستند الرسمي: "اختر ما
// ينطبق"، رسومها تتراكم فوق بعضها لو اختير أكثر من حالة معاً
const ERSAL_HANDLING = [
    { key: "normal", label: t("er_aady"), surcharge: 0, icon: Box },
    { key: "liquid", label: t("er_sayl"), surcharge: 1500, icon: Droplet },
    { key: "fragile", label: t("er_qabl_llksr"), surcharge: 2500, icon: AlertTriangle },
    { key: "fridge", label: t("er_mbrd"), surcharge: 4500, icon: Snowflake },
];
// سائق الاستلام وسائق التسليم شخصان مختلفان دائمًا — نموذج تشغيلي حقيقي
// موثّق صراحة، تحقّقنا منه بالصور الفعلية (FR-10462: عثمان الطيب للاستلام،
// محمد إبراهيم للتسليم — شخص مختلف كلياً بمركبة مختلفة)
const ERSAL_PICKUP_DRIVERS = [
    { name: "عثمان الطيب", vehicle: "نيسان باترول", plate: "خ ر ط ٥٦٧٨" },
    { name: "الفاتح عبدالله", vehicle: "تويوتا هايس", plate: "خ ر ط ٩٠١٢" },
];
const ERSAL_DELIVERY_DRIVERS = [
    { name: "محمد إبراهيم", vehicle: "تويوتا هايلوكس", plate: "خ ر ط ١٢٣٤" },
    { name: "صلاح الدين حسن", vehicle: "نيسان نافارا", plate: "خ ر ط ٣٤٥٦" },
];
// أسماء افتراضية لمن استلم الطرد فعلياً بالباب — يلتقطها المندوب بجهازه
// وقت التسليم الحقيقي، مو المُرسِل لاحقاً؛ هنا نحاكيها بأسماء واقعية بسيطة
const ERSAL_RECIPIENT_NAME_POOL = ["أحمد الطيب", "فاطمة النور", "عبدالله محمد", "زينب عثمان", "الأمين حسن"];
// توقيع مُولَّد برمجياً (مسار SVG بسيط) يمثّل توقيع المستلم الملتقَط بجهاز
// المندوب لحظة التسليم — محاكاة صادقة، مو رسماً حقيقياً لشخص فعلي
function generateSignaturePath() {
    const points = [];
    let x = 10, y = 30 + Math.random() * 10;
    for (let i = 0; i < 8; i++) {
        x += 20 + Math.random() * 15;
        y = 15 + Math.random() * 30;
        points.push(`${i === 0 ? "M" : "L"} ${x} ${y}`);
    }
    return points.join(" ");
}
// 4 طرق دفع بالضبط حسب المستند الرسمي (بدون محفظة سوا — غير مذكورة إطلاقاً
// بمنصة إرسال الأصلية، هذي منصة مستقلة عن سوا)
const ERSAL_PAYMENT_METHODS = [
    { key: "card", label: t("er_btaqa"), icon: CreditCard, badge: t("er_ykhsm_fwra") },
    { key: "corporate", label: t("er_hsab_alshrka"), icon: Building2, badge: t("er_ydaf_lfatwra") },
    { key: "cash", label: t("er_nqda"), icon: Banknote, badge: t("er_ywkd_ma_alsayq") },
    { key: "bank", label: t("er_thwyl_bnky"), icon: Landmark, badge: t("er_ywkd_ma_alsayq") },
];
const ERSAL_PAYMENT_TIMINGS = [{ key: "pickup", labelKey: "er_and_alastlam" }, { key: "delivery", labelKey: "er_and_altslym" }];
// 3 ثيمات ألوان خاصة بإرسال نفسه (تُطبَّق على تطبيقاته الثلاثة معًا حسب
// المستند — هنا ضمن تطبيق العميل فقط) — منفصلة تمامًا عن ثيمات سوا الأربعة
const ERSAL_THEMES = {
    default: { label: t("er_alaftrady"), primary: "#1E5FBF", primaryDark: "#153F80", primaryLight: "#D6E4FA", accent: "#D98E04", bg: "#F5F7FA" },
    desert: { label: t("er_alshra"), primary: "#B5652E", primaryDark: "#7A431E", primaryLight: "#F2DCC9", accent: "#C99A4A", bg: "#FBF7F2" },
    nile: { label: t("er_alnyl"), primary: "#0E8A82", primaryDark: "#0A5F59", primaryLight: "#CFEDEA", accent: "#C9A227", bg: "#F3FAF9" },
};
// رسوم تخزين يومية عند فشل التسليم (بعد 5 أيام عمل سماح) — ميزة لم تُذكر
// بالتوثيق الرئيسي إطلاقاً، وُثِّقت بالملحق التفصيلي فقط
const ERSAL_STORAGE_GRACE_DAYS = 5;
const ERSAL_RETURN_DEADLINE_DAYS = 10; // مهلة الإرجاع التلقائي لنقطة الانطلاق بعد فشل التسليم
const ERSAL_REDELIVERY_FEE = 2000; // رسوم ثابتة لإعادة جدولة التسليم بعنوان جديد
const ERSAL_STORAGE_FEES = {
    documents: 1000, books: 1000, electronics: 3000, appliances: 3500, medicine: 2000, other: 1500,
};
const ERSAL_FAILURE_REASON_KEYS = ["er_ghyr_mtwajd", "er_rfd_alastlam", "er_anwan_ghyr_shyh", "er_tadhr_altwasl"];
// مواقع محفوظة (استلام/تسليم) — تُستخدم بشاشة t("er_almwaqa")
const ERSAL_SAVED_PICKUP_LOCATIONS = [
    { id: "sp1", label: t("er_almstwda"), address: t("er_shara_aljmhwrya") },
    { id: "sp2", label: t("er_alfra_althanwy"), address: t("er_shara_alnyl") },
];
const ERSAL_SAVED_DELIVERY_LOCATIONS = [
    { id: "sd1", label: t("er_mnzl_alaayla"), address: t("er_am_drman") },
];
// تُرجع المراحل + مؤشرَي "آخر مرحلة لسائق الاستلام" و"أول مرحلة لسائق
// التسليم" — النموذج الحقيقي: سائق الاستلام مسؤول من الحجز حتى وصول
// الشحنة لمركز الخرطوم بس، بعدها عربة الشركة تنقلها بين المدن (بلا سائق
// فردي)، ثم سائق التسليم (شخص مختلف تمامًا) يتولاها من مركز الوجهة فصاعدًا
function ersalBuildStages(paymentTiming, paymentMethod, destName, deliveryMethod) {
    const originHub = t("mrkz_ERSAL_ORIGIN_CITY", { ERSAL_ORIGIN_CITY: t(ERSAL_ORIGIN_CITY_KEY) });
    const destHub = t("mrkz_destName", { destName });
    const needsDriverConfirm = paymentMethod === "cash" || paymentMethod === "bank";
    const methodLabel = paymentMethod === "bank" ? t("er_althwyl_albnky") : t("er_aldfa_alnqdy");
    const stages = [t("er_tm_alhjz")];
    if (needsDriverConfirm && paymentTiming === "pickup") {
        stages.push(t("takyd_alsayq_lastlam_and", { methodLabel }));
    }
    stages.push(t("er_tm_alastlam"), t("wswl_ila", { originHub }));
    const pickupEndIdx = stages.length - 1; // "وصول إلى مركز الخرطوم" — آخر مسؤولية سائق الاستلام
    stages.push(t("mghadra", { originHub }), t("wswl_ila_2", { destHub }));
    if (needsDriverConfirm && paymentTiming === "delivery") {
        stages.push(t("takyd_alsayq_lastlam_and_2", { methodLabel }));
    }
    const deliveryStartIdx = stages.length; // أول مرحلة تحتاج سائق تسليم (المرحلة التالية مباشرة)
    if (deliveryMethod === "branch") {
        stages.push(t("jahz_llastlam_mn", { destHub }), t("tm_alastlam_mn", { destHub }));
    }
    else {
        stages.push(t("er_qyd_altwsyl"), t("er_tm_altslym"));
    }
    return { stages, pickupEndIdx, deliveryStartIdx };
}
// ============================================================================
// خريطة تفاعلية (SVG قابلة للنقر) — بديل حقيقي لخرائط Google/Mapbox غير
// المتاحة بهذا النموذج. المستخدم ينقر فعلياً على نقاط بمساحة الخريطة،
// والإحداثيات (نسبة مئوية X/Y) تُخزَّن وتُستخدم لحساب مسافة تقديرية.
// ============================================================================
// طبقة اختيار موقع منفصلة (Modal) — تُفتح بس عند الضغط على "تحديد على
// الخريطة"، بدل خريطة مضمّنة دائمة تاخذ مساحة بالنموذج الرئيسي
function MapPickerModal({ title, initialPoint, showLocateMe = false, onConfirm, onClose }) {
    const { colors } = useTheme();
    const [point, setPoint] = useState(initialPoint || { x: 50, y: 50 });
    const [locating, setLocating] = useState(false);
    const [locateError, setLocateError] = useState(false);
    function locateMe() {
        if (!navigator.geolocation) {
            setLocateError(true);
            setTimeout(() => setLocateError(false), 2500);
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(() => {
            // إحداثيات GPS الحقيقية موجودة، لكن نعرضها على خريطة تمثيلية مبسّطة
            // (SVG)، فنحوّلها لموضع مركزي واقعي على الشبكة التمثيلية بدل إسقاط
            // إحداثيات جغرافية فعلية على رسم غير مرتبط بخرائط حقيقية
            setPoint({ x: 45 + Math.random() * 10, y: 45 + Math.random() * 10 });
            setLocating(false);
        }, () => { setLocateError(true); setLocating(false); setTimeout(() => setLocateError(false), 2500); }, { timeout: 8000 });
    }
    return (React.createElement("div", { className: "absolute inset-0 z-50 flex flex-col", style: { backgroundColor: colors.bg } },
        React.createElement(TopBar, { title: title, onBack: onClose }),
        React.createElement("div", { className: "flex-1 min-h-0 overflow-y-auto p-4" },
            showLocateMe && (React.createElement("button", { onClick: locateMe, disabled: locating, className: `w-full flex ${rowStart()} items-center justify-center gap-2 rounded-xl border-2 p-3 mb-3`, style: { borderColor: colors.primary, backgroundColor: colors.primaryLight } },
                React.createElement(Navigation, { size: 16, color: colors.primary }),
                React.createElement("span", { className: "text-sm font-bold", style: { color: colors.primary } }, locating ? "جارٍ تحديد موقعك..." : "حدّد موقعي بدقّة"))),
            locateError && (React.createElement("p", { className: "text-[10px] text-center mb-3", style: { color: colors.danger } }, t("tadhr_alwswl_lmwqak_takd"))),
            React.createElement(InteractiveMapPicker, { pickup: point, destination: null, onSetPickup: setPoint, onSetDestination: () => { }, mode: "pickup" }),
            React.createElement("p", { className: "text-xs text-center mt-3", style: { color: colors.textMuted } }, t("ashb_aldbws_lthdyd_almwqa"))),
        React.createElement("div", { className: "p-3 border-t", style: { borderColor: colors.border, backgroundColor: colors.card } },
            React.createElement(Button, { label: t("takyd_almwqa"), onPress: () => onConfirm(point) }))));
}
function InteractiveMapPicker({ pickup, destination, onSetPickup, onSetDestination, mode = "both" }) {
    const { colors } = useTheme();
    const svgRef = useRef(null);
    function handleClick(e) {
        const rect = svgRef.current.getBoundingClientRect();
        const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
        const y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
        if (mode === "pickup")
            onSetPickup({ x, y });
        else if (mode === "destination")
            onSetDestination({ x, y });
        else if (!pickup)
            onSetPickup({ x, y });
        else
            onSetDestination({ x, y });
    }
    const distanceKm = pickup && destination
        ? (Math.sqrt(Math.pow(destination.x - pickup.x, 2) + Math.pow(destination.y - pickup.y, 2)) / 100 * 18).toFixed(1)
        : null;
    return (React.createElement("div", null,
        React.createElement("svg", { ref: svgRef, onClick: handleClick, viewBox: "0 0 100 100", className: "w-full rounded-xl cursor-crosshair", style: { height: 220, backgroundColor: colors.bg, border: `1px solid ${colors.border}` } },
            [15, 35, 55, 75].map((v) => (React.createElement(React.Fragment, { key: v },
                React.createElement("line", { x1: v, y1: "0", x2: v, y2: "100", stroke: colors.border, strokeWidth: "0.6" }),
                React.createElement("line", { x1: "0", y1: v, x2: "100", y2: v, stroke: colors.border, strokeWidth: "0.6" })))),
            pickup && destination && (React.createElement("line", { x1: pickup.x, y1: pickup.y, x2: destination.x, y2: destination.y, stroke: colors.primary, strokeWidth: "1.2", strokeDasharray: "3,2" })),
            pickup && (React.createElement("g", { transform: `translate(${pickup.x}, ${pickup.y})` },
                React.createElement("circle", { r: "3.2", fill: colors.success }),
                React.createElement("circle", { r: "1.2", fill: "#fff" }))),
            destination && (React.createElement("g", { transform: `translate(${destination.x}, ${destination.y})` },
                React.createElement("circle", { r: "3.2", fill: colors.danger }),
                React.createElement("circle", { r: "1.2", fill: "#fff" })))),
        React.createElement("div", { className: `flex ${rowStart()} justify-between mt-2 text-[11px]`, style: { color: colors.textMuted } },
            React.createElement("span", null, pickup ? "✓ نقطة الاستلام مُحدَّدة" : "انقر لتحديد نقطة الاستلام"),
            React.createElement("span", null, destination ? "✓ الوجهة مُحدَّدة" : "ثم انقر لتحديد الوجهة")),
        distanceKm && React.createElement("div", { className: "text-xs font-bold mt-1", style: { color: colors.primary } },
            "\u0645\u0633\u0627\u0641\u0629 \u062A\u0642\u062F\u064A\u0631\u064A\u0629: ",
            distanceKm,
            " \u0643\u0645")));
}
// معاينة السائقين القريبين — مواضع تمثيلية محاكاة (لا يوجد نظام تتبّع سائقين
// حقيقي بهذي المعاينة)، لكنها تعطي إحساساً واقعياً بالسائقين المتوفّرين حولك
function NearbyDriversPreview({ pickup }) {
    const { colors } = useTheme();
    const nearbyOffsets = [
        { dx: -8, dy: -6, eta: 3 },
        { dx: 10, dy: -4, eta: 5 },
        { dx: -5, dy: 9, eta: 6 },
        { dx: 7, dy: 7, eta: 4 },
    ];
    return (React.createElement("div", { className: "mb-4" },
        React.createElement("svg", { viewBox: "0 0 100 100", className: "w-full rounded-xl", style: { height: 160, backgroundColor: colors.bg, border: `1px solid ${colors.border}` } },
            [15, 35, 55, 75].map((v) => (React.createElement(React.Fragment, { key: v },
                React.createElement("line", { x1: v, y1: "0", x2: v, y2: "100", stroke: colors.border, strokeWidth: "0.6" }),
                React.createElement("line", { x1: "0", y1: v, x2: "100", y2: v, stroke: colors.border, strokeWidth: "0.6" })))),
            nearbyOffsets.map((o, i) => (React.createElement("g", { key: i, transform: `translate(${Math.max(4, Math.min(96, pickup.x + o.dx))}, ${Math.max(4, Math.min(96, pickup.y + o.dy))})` },
                React.createElement("circle", { r: "2.6", fill: colors.primary, opacity: "0.85" }),
                React.createElement("foreignObject", { x: "-2", y: "-2", width: "4", height: "4" },
                    React.createElement("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" } },
                        React.createElement(Car, { size: 4.5, color: "#fff" })))))),
            React.createElement("g", { transform: `translate(${pickup.x}, ${pickup.y})` },
                React.createElement("circle", { r: "3.2", fill: colors.success }),
                React.createElement("circle", { r: "1.2", fill: "#fff" }))),
        React.createElement("p", { className: "text-[11px] text-center mt-1.5", style: { color: colors.textMuted } },
            nearbyOffsets.length,
            " \u0633\u0627\u0626\u0642\u064A\u0646 \u0642\u0631\u064A\u0628\u064A\u0646 \u0645\u0646\u0643 \u2014 \u0623\u0642\u0631\u0628 \u0633\u0627\u0626\u0642 \u0639\u0644\u0649 \u0628\u064F\u0639\u062F ",
            Math.min(...nearbyOffsets.map((o) => o.eta)),
            " \u062F\u0642\u0627\u0626\u0642")));
}
// خريطة تتبع متحركة — أيقونة تتحرك فعلياً على مسار SVG بمرور الوقت (setInterval حقيقي)
function AnimatedTrackingMap({ progress, icon: TrackIcon = Car, pickup, destination, driverApproaching = false }) {
    const { colors } = useTheme();
    // قبل بدء الرحلة: السائق يتحرّك من نقطة عشوائية قريبة نحو نقطة الاستلام
    // الفعلية (مسار إلى نقطة اللقاء تحديداً). بعد بدء الرحلة: يتحرّك من
    // الاستلام إلى الوجهة الفعليتين المُختارتين، بدل مسار تمثيلي ثابت
    const driverStart = useMemo(() => {
        var _a, _b;
        return ({
            x: Math.max(4, Math.min(96, ((_a = pickup === null || pickup === void 0 ? void 0 : pickup.x) !== null && _a !== void 0 ? _a : 50) + (Math.random() > 0.5 ? 18 : -18))),
            y: Math.max(4, Math.min(96, ((_b = pickup === null || pickup === void 0 ? void 0 : pickup.y) !== null && _b !== void 0 ? _b : 50) + (Math.random() > 0.5 ? 18 : -18))),
        });
    }, [pickup === null || pickup === void 0 ? void 0 : pickup.x, pickup === null || pickup === void 0 ? void 0 : pickup.y, driverApproaching]);
    const from = driverApproaching ? driverStart : (pickup || { x: 15, y: 80 });
    const to = driverApproaching ? (pickup || { x: 50, y: 50 }) : (destination || { x: 85, y: 20 });
    const carX = from.x + (to.x - from.x) * progress;
    const carY = from.y + (to.y - from.y) * progress;
    return (React.createElement("svg", { viewBox: "0 0 100 100", className: "w-full rounded-xl", style: { height: 180, backgroundColor: colors.bg, border: `1px solid ${colors.border}` } },
        React.createElement("polyline", { points: `${from.x},${from.y} ${to.x},${to.y}`, fill: "none", stroke: driverApproaching ? colors.accent : colors.border, strokeWidth: "1.5", strokeDasharray: "2,2" }),
        React.createElement("g", { transform: `translate(${from.x}, ${from.y})` },
            React.createElement("circle", { r: "2.5", fill: driverApproaching ? colors.primary : colors.success, opacity: driverApproaching ? 0.5 : 1 })),
        React.createElement("g", { transform: `translate(${to.x}, ${to.y})` },
            React.createElement("circle", { r: "2.5", fill: driverApproaching ? colors.success : colors.danger }),
            React.createElement("circle", { r: "1", fill: "#fff" })),
        React.createElement("g", { transform: `translate(${carX}, ${carY})` },
            React.createElement("circle", { r: "4", fill: colors.primary }),
            React.createElement("foreignObject", { x: "-3", y: "-3", width: "6", height: "6" },
                React.createElement("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" } },
                    React.createElement(TrackIcon, { size: 6, color: "#fff" })))),
        driverApproaching && (React.createElement("text", { x: to.x, y: to.y - 5, fontSize: "3.5", fill: colors.success, textAnchor: "middle", fontWeight: "bold" }, t("nqta_allqa")))));
}
// ملاحظة: نظام الألوان الفعلي بإرسال أصبح 3 ثيمات (ERSAL_THEMES أعلاه)
// حسب المستند الرسمي، بدل لون أخضر ثابت واحد كان مفترضاً سابقاً
function ErsalScreen({ shipments, onCreateShipment, onMarkFailed, onBulkCreateShipments, onChangeAddress, onConfirmPickup, onSimulateDays, onCancelShipment, onRateCourier, onReorderShipment, onBack }) {
    const outerTheme = useTheme();
    const [ersalThemeKey, setErsalThemeKey] = useState("default"); // 3 ثيمات خاصة بمنصة إرسال نفسها (موثّقة رسمياً)
    const themeColors = ERSAL_THEMES[ersalThemeKey];
    const ersalTheme = {
        ...outerTheme,
        colors: { ...outerTheme.colors, primary: themeColors.primary, primaryDark: themeColors.primaryDark, primaryLight: themeColors.primaryLight, accent: themeColors.accent, bg: themeColors.bg },
        ersalThemeKey, setErsalThemeKey,
    };
    return (React.createElement(ThemeContext.Provider, { value: ersalTheme },
        React.createElement(ErsalScreenInner, { shipments: shipments, onCreateShipment: onCreateShipment, onMarkFailed: onMarkFailed, onBulkCreateShipments: onBulkCreateShipments, onChangeAddress: onChangeAddress, onConfirmPickup: onConfirmPickup, onSimulateDays: onSimulateDays, onCancelShipment: onCancelShipment, onRateCourier: onRateCourier, onReorderShipment: onReorderShipment, onBack: onBack })));
}
const ERSAL_BOTTOM_NAV = [
    { key: "home", label: t("er_alrysya"), icon: Compass },
    { key: "ship", label: t("er_shhn"), icon: Package },
    { key: "track", label: t("er_ttba"), icon: Truck },
    { key: "billing", label: t("er_alfwatyr"), icon: CreditCard },
    { key: "account", label: t("er_alhsab"), icon: UserCircle },
];
function ErsalScreenInner({ shipments, onCreateShipment, onMarkFailed, onBulkCreateShipments, onChangeAddress, onConfirmPickup, onSimulateDays, onCancelShipment, onRateCourier, onReorderShipment, onBack }) {
    const { colors, isDark, ersalThemeKey, setErsalThemeKey } = useTheme();
    const { showToast } = useToast();
    const [confirmingCancelId, setConfirmingCancelId] = useState(null);
    const [shipmentSearchQuery, setShipmentSearchQuery] = useState("");
    const [shipmentStatusFilter, setShipmentStatusFilter] = useState("all");
    const filteredShipments = shipments.filter((s) => {
        const isDelivered = s.stageIdx >= s.stages.length - 1;
        const matchesStatus = shipmentStatusFilter === "all" ? true :
            shipmentStatusFilter === "delivered" ? (isDelivered && !s.failed) :
                shipmentStatusFilter === "failed" ? s.failed :
                    /* active */ (!isDelivered && !s.failed && !s.cancelled);
        const q = shipmentSearchQuery.trim().toLowerCase();
        const matchesSearch = !q || s.id.toLowerCase().includes(q) || s.destination.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
        return matchesStatus && matchesSearch;
    });
    const [viewingInvoiceId, setViewingInvoiceId] = useState(null);
    const [mainTab, setMainTab] = useState("home"); // home | ship | track | billing | account
    const [shipFlowView, setShipFlowView] = useState("goods"); // goods | price | payment
    const [accountSubView, setAccountSubView] = useState(null); // null | corporateStatement | bulkUpload | savedLocations
    const [savedPickupLocations, setSavedPickupLocations] = useState(ERSAL_SAVED_PICKUP_LOCATIONS);
    const [savedDeliveryLocations, setSavedDeliveryLocations] = useState(ERSAL_SAVED_DELIVERY_LOCATIONS);
    const [savedRecipients, setSavedRecipients] = useState([
        { id: "rcp-1", name: "أحمد الطيب", phone: "0912223344" },
        { id: "rcp-2", name: "فاطمة النور", phone: "0918887766" },
    ]);
    const [recipientName, setRecipientName] = useState("");
    const [recipientPhone, setRecipientPhone] = useState("");
    function saveCurrentRecipient() {
        if (!recipientName.trim() || !recipientPhone.trim())
            return;
        setSavedRecipients((prev) => [...prev, { id: `rcp-${Date.now()}`, name: recipientName.trim(), phone: recipientPhone.trim() }]);
        showToast(t("tm_hfz_almstlm_bdftr"), "success");
    }
    function addSavedLocation(kind, label, address) {
        const newLoc = { id: `${kind === "pickup" ? "sp" : "sd"}-${Date.now()}`, label, address };
        if (kind === "pickup")
            setSavedPickupLocations((prev) => [...prev, newLoc]);
        else
            setSavedDeliveryLocations((prev) => [...prev, newLoc]);
        showToast(t("tm_hfz_almwqa"), "success");
    }
    function deleteSavedLocation(kind, id) {
        if (kind === "pickup")
            setSavedPickupLocations((prev) => prev.filter((l) => l.id !== id));
        else
            setSavedDeliveryLocations((prev) => prev.filter((l) => l.id !== id));
        showToast(t("tm_hdhf_almwqa"), "success");
    }
    const [trackingNumber, setTrackingNumber] = useState("");
    const [cityIdx, setCityIdx] = useState(0);
    const [typeKey, setTypeKey] = useState("documents");
    const [handlingKeys, setHandlingKeys] = useState(["normal"]); // اختيار متعدد حقيقي
    const [weight, setWeight] = useState("");
    const [dimensions, setDimensions] = useState({ height: "", width: "", length: "" });
    const [pickupPoint, setPickupPoint] = useState({ x: 30, y: 70 });
    const [deliveryPoint, setDeliveryPoint] = useState(null);
    const [pickupAddressText, setPickupAddressText] = useState(t("er_shara_aljmhwrya"));
    const [deliveryAddressText, setDeliveryAddressText] = useState("");
    const [mapModalFor, setMapModalFor] = useState(null); // null | "pickup" | "delivery"
    const [changingAddressFor, setChangingAddressFor] = useState(null); // معرّف الشحنة اللي نغيّر عنوانها
    const [newAddressInput, setNewAddressInput] = useState("");
    const [showExtraDetails, setShowExtraDetails] = useState(false);
    const [deliveryMethod, setDeliveryMethod] = useState("address");
    const [paymentMethod, setPaymentMethod] = useState("card");
    const [paymentTiming, setPaymentTiming] = useState("pickup");
    const [packagePhoto, setPackagePhoto] = useState(null);
    const [viewingProofId, setViewingProofId] = useState(null);
    const [callingDriverFor, setCallingDriverFor] = useState(null);
    const [insuranceEnabled, setInsuranceEnabled] = useState(false);
    const [declaredValue, setDeclaredValue] = useState("");
    const [deliveryWindow, setDeliveryWindow] = useState(null);
    const [contentDescription, setContentDescription] = useState("");
    const [shipmentReference, setShipmentReference] = useState("");
    const city = ERSAL_CITIES[cityIdx];
    const type = ERSAL_SHIPMENT_TYPES.find((t) => t.key === typeKey);
    const weightNum = Number(weight) || 0;
    const weightFee = Math.round(weightNum * ERSAL_WEIGHT_FEE_PER_KG);
    const handlingSurcharge = handlingKeys.reduce((sum, k) => { var _a; return sum + (((_a = ERSAL_HANDLING.find((h) => h.key === k)) === null || _a === void 0 ? void 0 : _a.surcharge) || 0); }, 0);
    const insuranceFee = insuranceEnabled ? Math.round((Number(declaredValue) || 0) * ERSAL_INSURANCE_RATE) : 0;
    const total = ERSAL_BASE_PRICE + weightFee + city.fee + type.surcharge + handlingSurcharge + insuranceFee;
    const needsDriverConfirm = paymentMethod === "cash" || paymentMethod === "bank";
    function toggleHandling(key) {
        setHandlingKeys((prev) => {
            if (key === "normal")
                return ["normal"];
            const withoutNormal = prev.filter((k) => k !== "normal");
            return prev.includes(key) ? withoutNormal.filter((k) => k !== key) : [...withoutNormal, key];
        });
    }
    const activeShipments = shipments.filter((s) => s.stageIdx < s.stages.length - 1 && !s.failed);
    const onTimeCount = shipments.filter((s) => s.stageIdx >= s.stages.length - 1 && !s.failed).length;
    const showBottomNav = mainTab !== "ship" || shipFlowView === "goods";
    function renderContent() {
        if (mainTab === "ship") {
            if (shipFlowView === "goods") {
                return (React.createElement("div", { dir: isRTL() ? "rtl" : "ltr", className: "flex-1 min-h-0 flex flex-col" },
                    React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                        React.createElement("h2", { className: "text-lg font-extrabold mb-3", style: { color: colors.text } }, t("shhna_jdyda")),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("anwan_alastlam")),
                        React.createElement("button", { onClick: () => setMapModalFor("pickup"), className: `w-full ${textStart()}` },
                            React.createElement(Card, { className: `flex ${rowStart()} items-center justify-between` },
                                React.createElement("div", { className: "flex-1" },
                                    React.createElement("div", { className: "text-[10px]", style: { color: colors.primary } }, t("thdyd_ala_alkhryta")),
                                    React.createElement("div", { className: "text-xs mt-0.5", style: { color: colors.text } }, pickupAddressText || t("er_lm_yhdd"))),
                                React.createElement(MapPin, { size: 16, color: colors.primary }))),
                        React.createElement("div", { className: `flex ${rowStart()} flex-wrap gap-2 mb-4` }, savedPickupLocations.map((loc) => (React.createElement("button", { key: loc.id, onClick: () => setPickupAddressText(loc.address), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1`, style: { borderColor: colors.border } },
                            React.createElement(Bookmark, { size: 11, color: colors.textMuted }),
                            React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.text } }, loc.label))))),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("mdyna_alwjha")),
                        React.createElement("select", { value: cityIdx, onChange: (e) => { setCityIdx(Number(e.target.value)); setDeliveryAddressText(""); }, className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-4", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }, ERSAL_CITIES.map((c, i) => (React.createElement("option", { key: c.name, value: i },
                            c.name,
                            " \u2014 ",
                            c.zone,
                            " \u00B7 ",
                            c.fee.toLocaleString(loc()),
                            t("w_sdg_sp"))))),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("byanat_almstlm")),
                        savedRecipients.length > 0 && (React.createElement("div", { className: `flex ${rowStart()} flex-wrap gap-2 mb-2` }, savedRecipients.map((r) => (React.createElement("button", { key: r.id, onClick: () => { setRecipientName(r.name); setRecipientPhone(r.phone); }, className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1`, style: { borderColor: recipientName === r.name && recipientPhone === r.phone ? colors.primary : colors.border } },
                            React.createElement(UserCircle, { size: 12, color: colors.textMuted }),
                            React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.text } }, r.name)))))),
                        React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-2` },
                            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: recipientName, onChange: (e) => setRecipientName(e.target.value), placeholder: t("asm_almstlm"), className: "flex-1 border rounded-xl px-3 py-2 text-sm", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                            React.createElement("input", { value: recipientPhone, onChange: (e) => setRecipientPhone(e.target.value.replace(/\D/g, "")), placeholder: t("rqm_alhatf"), inputMode: "numeric", className: "flex-1 border rounded-xl px-3 py-2 text-sm", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card }, dir: "ltr" })),
                        recipientName.trim() && recipientPhone.trim() && !savedRecipients.some((r) => r.name === recipientName && r.phone === recipientPhone) && (React.createElement("button", { onClick: saveCurrentRecipient, className: `flex ${rowStart()} items-center gap-1 mb-4` },
                            React.createElement(Bookmark, { size: 11, color: colors.primary }),
                            React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.primary } }, t("hfz_bdftr_alanawyn_lastkhdamh")))),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } },
                            t("er_tryqa_astlam"),
                            city.name),
                        React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-4` },
                            React.createElement("button", { onClick: () => setDeliveryMethod("address"), className: "flex-1 rounded-xl border-2 p-3 text-center", style: { borderColor: deliveryMethod === "address" ? colors.primary : colors.border, backgroundColor: deliveryMethod === "address" ? colors.primary : colors.card } },
                                React.createElement("span", { className: "text-xs font-bold", style: { color: deliveryMethod === "address" ? "#fff" : colors.text } }, t("twsyl_ila_anwan"))),
                            React.createElement("button", { onClick: () => setDeliveryMethod("branch"), className: "flex-1 rounded-xl border-2 p-3 text-center", style: { borderColor: deliveryMethod === "branch" ? colors.primary : colors.border, backgroundColor: deliveryMethod === "branch" ? colors.primary : colors.card } },
                                React.createElement("span", { className: "text-xs font-bold", style: { color: deliveryMethod === "branch" ? "#fff" : colors.text } }, t("alastlam_mn_fra_alshrka")))),
                        deliveryMethod === "address" ? (React.createElement(React.Fragment, null,
                            React.createElement("label", { className: "text-[11px] font-bold mb-2 block", style: { color: colors.textMuted } }, t("anwan_altslym_altfsyly_akhtyary")),
                            React.createElement("button", { onClick: () => setMapModalFor("delivery"), className: `w-full ${textStart()}` },
                                React.createElement(Card, { className: `flex ${rowStart()} items-center justify-between` },
                                    React.createElement("div", { className: "flex-1" },
                                        React.createElement("div", { className: "text-[10px]", style: { color: colors.primary } }, t("thdyd_ala_alkhryta")),
                                        React.createElement("div", { className: "text-xs mt-0.5", style: { color: colors.text } }, deliveryAddressText || t("lm_yhdd_bad_syslm", { name: city.name }))),
                                    React.createElement(MapPin, { size: 16, color: colors.primary }))),
                            React.createElement("div", { className: `flex ${rowStart()} flex-wrap gap-2 mb-4` },
                                savedDeliveryLocations.map((loc) => (React.createElement("button", { key: loc.id, onClick: () => setDeliveryAddressText(loc.address), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1`, style: { borderColor: colors.border } },
                                    React.createElement(Bookmark, { size: 11, color: colors.textMuted }),
                                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.text } }, loc.label)))),
                                React.createElement("button", { onClick: () => setDeliveryAddressText(t("fra_alshrka", { name: city.name })), className: `flex ${rowStart()} items-center gap-1 rounded-full border px-2.5 py-1`, style: { borderColor: colors.border } },
                                    React.createElement(Bookmark, { size: 11, color: colors.textMuted }),
                                    React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.text } },
                                        t("er_fra_alshrka"),
                                        city.name))),
                            React.createElement("label", { className: "text-[11px] font-bold mb-2 block", style: { color: colors.textMuted } }, t("alftra_almfdla_lltslym_akhtyary")),
                            React.createElement("div", { className: "grid grid-cols-2 gap-2 mb-4" }, ERSAL_DELIVERY_WINDOWS.map((w) => (React.createElement("button", { key: w.key, onClick: () => setDeliveryWindow(deliveryWindow === w.key ? null : w.key), className: `rounded-xl border-2 py-2 flex ${rowStart()} items-center justify-center gap-1.5`, style: { borderColor: deliveryWindow === w.key ? colors.primary : colors.border, backgroundColor: deliveryWindow === w.key ? colors.primaryLight : "transparent" } },
                                React.createElement(Clock, { size: 12, color: deliveryWindow === w.key ? colors.primary : colors.textMuted }),
                                React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.text } }, w.label))))))) : (React.createElement(Card, { className: `flex ${rowStart()} items-center gap-2 mb-4` },
                            React.createElement("div", { className: "w-9 h-9 rounded-full flex items-center justify-center", style: { backgroundColor: colors.primaryLight } },
                                React.createElement(MapPin, { size: 16, color: colors.primary })),
                            React.createElement("div", null,
                                React.createElement("div", { className: "text-xs font-bold", style: { color: colors.text } },
                                    t("er_mrkz"),
                                    city.name,
                                    t("er_lkhdmat")),
                                React.createElement("div", { className: "text-[10px]", style: { color: colors.textMuted } }, t("mwqa_thabt_astlm_trdk"))))),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("nwa_alshhna")),
                        React.createElement("div", { className: "mb-4" }, ERSAL_SHIPMENT_TYPES.map((stype) => {
                            const active = typeKey === stype.key;
                            return (React.createElement("button", { key: stype.key, onClick: () => setTypeKey(stype.key), className: `w-full flex ${rowStart()} items-center gap-3 rounded-xl border-2 p-3 mb-2`, style: { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.card } },
                                React.createElement("div", { className: "w-9 h-9 rounded-full flex items-center justify-center shrink-0", style: { backgroundColor: active ? colors.primary : colors.bg } }, React.createElement(stype.icon, { size: 16, color: active ? "#fff" : colors.textMuted })),
                                React.createElement("span", { className: `flex-1 text-sm font-bold ${textStart()}`, style: { color: colors.text } }, stype.label),
                                stype.surcharge > 0 && React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } },
                                    "+",
                                    stype.surcharge.toLocaleString(loc()),
                                    t("w_sdg_sp")),
                                React.createElement("div", { className: "w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0", style: { borderColor: active ? colors.primary : colors.border } }, active && React.createElement("div", { className: "w-2.5 h-2.5 rounded-full", style: { backgroundColor: colors.primary } }))));
                        })),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("hala_alshhna_akhtr_ma")),
                        React.createElement("div", { className: "mb-4" }, ERSAL_HANDLING.map((h) => {
                            const active = handlingKeys.includes(h.key);
                            return (React.createElement("button", { key: h.key, onClick: () => toggleHandling(h.key), className: `w-full flex ${rowStart()} items-center gap-3 rounded-xl border-2 p-3 mb-2`, style: { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.card } },
                                React.createElement("div", { className: "w-9 h-9 rounded-full flex items-center justify-center shrink-0", style: { backgroundColor: active ? colors.primary : colors.bg } },
                                    React.createElement(h.icon, { size: 16, color: active ? "#fff" : colors.textMuted })),
                                React.createElement("span", { className: `flex-1 text-sm font-bold ${textStart()}`, style: { color: colors.text } }, h.label),
                                h.surcharge > 0 && React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } },
                                    "+",
                                    h.surcharge.toLocaleString(loc()),
                                    t("w_sdg_sp")),
                                React.createElement("div", { className: "w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0", style: { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary : "transparent" } }, active && React.createElement(Check, { size: 13, color: "#fff" }))));
                        })),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("alwzn_kjm")),
                        React.createElement("input", { dir: "ltr", value: weight, onChange: (e) => setWeight(e.target.value), type: "number", placeholder: "0", className: "w-full border rounded-xl px-3 py-2.5 text-sm mb-3", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                        React.createElement("label", { className: "text-[11px] font-bold mb-1 block", style: { color: colors.text } }, t("wsf_mkhtsr_llmhtwa")),
                        React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: contentDescription, onChange: (e) => setContentDescription(e.target.value), placeholder: t("mthal_qtatan_mlabs_rjaly"), className: "w-full border rounded-xl px-3 py-2 text-sm mb-3", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                        React.createElement("label", { className: "text-[11px] font-bold mb-1 block", style: { color: colors.text } }, t("alqyma_almsrh_bha_j")),
                        React.createElement("input", { dir: "ltr", value: declaredValue, onChange: (e) => setDeclaredValue(e.target.value.replace(/\D/g, "")), inputMode: "numeric", placeholder: t("mthal_50000"), className: "w-full border rounded-xl px-3 py-2 text-sm mb-1", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                        React.createElement("p", { className: "text-[10px] mb-3", style: { color: colors.textMuted } }, t("tstkhdm_lthdyd_almswwlya_and")),
                        React.createElement("button", { onClick: () => setShowExtraDetails(!showExtraDetails), className: `flex ${rowStart()} items-center gap-1.5 mb-3` },
                            React.createElement("span", { className: "text-xs font-bold", style: { color: colors.primary } }, t("tfasyl_idafya_akhtyary")),
                            React.createElement(ChevronLeft, { size: 14, color: colors.primary, style: { transform: showExtraDetails ? "rotate(-90deg)" : "rotate(180deg)" } })),
                        showExtraDetails && (React.createElement("div", { className: "mb-4" },
                            React.createElement("label", { className: "text-[11px] mb-1 block", style: { color: colors.textMuted } }, t("alhjm_sm")),
                            React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-3` }, [["length", t("er_altwl")], ["width", t("er_alard")], ["height", t("er_alartfaa")]].map(([key, label]) => (React.createElement("div", { key: key, className: "flex-1" },
                                React.createElement("input", { dir: "ltr", value: dimensions[key], onChange: (e) => setDimensions((prev) => ({ ...prev, [key]: e.target.value })), type: "number", placeholder: label, className: "w-full border rounded-xl px-2 py-2 text-xs text-center", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                                React.createElement("span", { className: "text-[9px] block text-center mt-0.5", style: { color: colors.textMuted } }, label))))),
                            React.createElement("label", { className: "text-[11px] mb-1 block", style: { color: colors.textMuted } }, t("rqm_mrjay_dakhly_akhtyary")),
                            React.createElement("input", { dir: "ltr", value: shipmentReference, onChange: (e) => setShipmentReference(e.target.value), placeholder: t("mthal_rqm_tlb_almtjr"), className: "w-full border rounded-xl px-3 py-2 text-xs", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } })))),
                    React.createElement("button", { onClick: () => setInsuranceEnabled(!insuranceEnabled), className: `w-full flex ${rowStart()} items-center justify-between rounded-xl border p-2.5 mb-3`, style: { borderColor: insuranceEnabled ? colors.primary : colors.border, backgroundColor: insuranceEnabled ? colors.primaryLight : "transparent" } },
                        React.createElement("div", { className: `flex ${rowStart()} items-center gap-2` },
                            React.createElement(ShieldCheck, { size: 15, color: insuranceEnabled ? colors.primary : colors.textMuted }),
                            React.createElement("span", { className: "text-xs font-bold", style: { color: colors.text } }, t("tamyn_akhtyary_ala_alshhna"))),
                        React.createElement("div", { className: "w-9 h-5 rounded-full relative", style: { backgroundColor: insuranceEnabled ? colors.primary : colors.border } },
                            React.createElement("span", { className: "absolute top-0.5 w-4 h-4 rounded-full bg-white", style: { [insuranceEnabled ? "right" : "left"]: 2 } }))),
                    insuranceEnabled && (React.createElement("div", { className: "mb-3" }, Number(declaredValue) > 0 ? (React.createElement("p", { className: "text-[10px]", style: { color: colors.textMuted } },
                        t("er_rsm_altamyn"),
                        ERSAL_INSURANCE_RATE * 100,
                        t("er_mn_alqyma"),
                        insuranceFee.toLocaleString(loc()),
                        t("er_ywdk"))) : (React.createElement("p", { className: "text-[10px]", style: { color: colors.danger } }, t("adkhl_alqyma_almsrh_bha"))))),
                    React.createElement("div", { className: "p-3 border-t", style: { borderColor: colors.border, backgroundColor: colors.card } },
                        React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-2` },
                            React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, t("alijmaly_altqdyry")),
                            React.createElement("span", { className: "text-base font-extrabold", style: { color: colors.accent } },
                                total.toLocaleString(loc()),
                                t("w_sdg_sp"))),
                        React.createElement(Button, { label: t("ahsl_ala_ard_sar"), onPress: () => setShipFlowView("price"), disabled: !weight || weightNum <= 0 }))));
            }
            if (shipFlowView === "price") {
                return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
                    React.createElement(TopBar, { title: t("ard_alsar"), onBack: () => setShipFlowView("goods") }),
                    React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                        React.createElement(Card, { style: { padding: 14 } },
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", null, t("alsar_alasasy")),
                                React.createElement("span", { style: { color: colors.text } },
                                    ERSAL_BASE_PRICE.toLocaleString(loc()),
                                    t("w_sdg_sp"))),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", null,
                                    t("er_rswm_alwzn"),
                                    weightNum,
                                    t("er_kjm")),
                                React.createElement("span", { style: { color: colors.text } },
                                    weightFee.toLocaleString(loc()),
                                    t("w_sdg_sp"))),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", null,
                                    t("er_rswm_almntqa"),
                                    city.zone,
                                    ")"),
                                React.createElement("span", { style: { color: colors.text } },
                                    city.fee.toLocaleString(loc()),
                                    t("w_sdg_sp"))),
                            type.surcharge > 0 && (React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", null, t("rswm_nwa_alshhna")),
                                React.createElement("span", { style: { color: colors.text } },
                                    type.surcharge.toLocaleString(loc()),
                                    t("w_sdg_sp")))),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", null,
                                    t("er_rswm_mnawla"),
                                    handlingKeys.map((k) => { var _a; return (_a = ERSAL_HANDLING.find((h) => h.key === k)) === null || _a === void 0 ? void 0 : _a.label; }).join(t("er_fasl"))),
                                React.createElement("span", { style: { color: colors.text } },
                                    handlingSurcharge.toLocaleString(loc()),
                                    t("w_sdg_sp"))),
                            insuranceEnabled && insuranceFee > 0 && (React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1.5`, style: { color: colors.textMuted } },
                                React.createElement("span", { className: `flex ${rowStart()} items-center gap-1` },
                                    React.createElement(ShieldCheck, { size: 11, color: colors.primary }),
                                    t("er_tamyn"),
                                    ERSAL_INSURANCE_RATE * 100,
                                    t("er_pct")),
                                React.createElement("span", { style: { color: colors.text } },
                                    insuranceFee.toLocaleString(loc()),
                                    t("w_sdg_sp")))),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-sm font-extrabold mt-2 pt-2 border-t`, style: { borderColor: colors.border, color: colors.accent } },
                                React.createElement("span", null, t("alijmaly")),
                                React.createElement("span", null,
                                    total.toLocaleString(loc()),
                                    t("w_sdg_sp")))),
                        React.createElement(Card, { style: { padding: 12, backgroundColor: colors.primaryLight } },
                            React.createElement("div", { className: `flex ${rowStart()} items-center gap-2` },
                                React.createElement(Clock, { size: 14, color: colors.primary }),
                                React.createElement("span", { className: "text-xs font-bold", style: { color: colors.primaryDark } },
                                    t("er_alwqt_almtwqa"),
                                    t(ERSAL_ORIGIN_CITY_KEY),
                                    t("er_wmrkz"),
                                    city.name))),
                        React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("jdwla_alastlam")),
                        React.createElement(Card, { className: `flex ${rowStart()} items-center justify-between` },
                            React.createElement("span", { className: "text-xs", style: { color: colors.text } }, t("ghda_9_00_11")),
                            React.createElement(Clock, { size: 14, color: colors.textMuted })),
                        React.createElement(Button, { label: t("almtabaa_ila_aldfa"), onPress: () => setShipFlowView("payment"), className: "mt-4" }))));
            }
            return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
                React.createElement(TopBar, { title: t("aldfa"), onBack: () => setShipFlowView("price") }),
                React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                    React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("tryqa_aldfa")),
                    React.createElement("div", { className: "mb-4" }, ERSAL_PAYMENT_METHODS.map((m) => {
                        const isSelected = paymentMethod === m.key;
                        const methodNeedsConfirm = m.key === "cash" || m.key === "bank";
                        return (React.createElement("div", { key: m.key, className: "mb-2" },
                            React.createElement("button", { onClick: () => setPaymentMethod(m.key), className: `w-full flex ${rowStart()} items-center gap-3 rounded-xl border-2 p-3`, style: { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primaryLight : colors.card } },
                                React.createElement("div", { className: "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0", style: { backgroundColor: isSelected ? colors.primary : colors.bg } },
                                    React.createElement(m.icon, { size: 18, color: isSelected ? "#fff" : colors.textMuted })),
                                React.createElement("div", { className: `flex-1 ${textStart()}` },
                                    React.createElement("div", { className: "text-sm font-bold", style: { color: colors.text } }, m.label),
                                    React.createElement("div", { className: "text-[10px] mt-0.5", style: { color: colors.textMuted } }, m.badge)),
                                isSelected ? React.createElement(CheckCircle2, { size: 20, color: colors.primary }) : React.createElement("div", { className: "w-5 h-5 rounded-full border-2", style: { borderColor: colors.border } })),
                            isSelected && methodNeedsConfirm && (React.createElement("div", { className: "rounded-xl border-2 border-t-0 rounded-t-none p-3", style: { borderColor: colors.primary, backgroundColor: colors.card, marginTop: -8, paddingTop: 12 } },
                                React.createElement("label", { className: "text-[11px] font-bold mb-2 block", style: { color: colors.text } }, t("mta_tryd_aldfa")),
                                React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-2` }, ERSAL_PAYMENT_TIMINGS.map((ptiming) => React.createElement(Chip, { key: ptiming.key, label: t(ptiming.labelKey), active: paymentTiming === ptiming.key, onPress: () => setPaymentTiming(ptiming.key) }))),
                                React.createElement("div", { className: `flex ${rowStart()} items-start gap-1.5 rounded-xl p-2`, style: { backgroundColor: colors.primaryLight } },
                                    React.createElement(Truck, { size: 13, color: colors.primaryDark, className: "mt-0.5" }),
                                    React.createElement("p", { className: "text-[10px] flex-1", style: { color: colors.primaryDark } },
                                        t("er_jhz_almblgh"),
                                        m.key === "bank" ? t("er_bhsab_jahz") : t("er_nqda"),
                                        t("er_syakd"),
                                        paymentTiming === "pickup" ? t("er_antlaq") : t("er_tslym_lk"),
                                        t("er_wsthsl")))))));
                    })),
                    React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("swra_altrd_ltakyd_alshhna")),
                    React.createElement("button", { onClick: () => setPackagePhoto((prev) => (prev ? null : { name: t("er_swra_mlf") })), className: "w-full border-2 border-dashed rounded-xl p-4 flex flex-col items-center mb-4", style: { borderColor: packagePhoto ? colors.success : colors.border } },
                        React.createElement(Camera, { size: 22, color: packagePhoto ? colors.success : colors.textMuted }),
                        React.createElement("span", { className: "text-xs font-bold mt-1", style: { color: packagePhoto ? colors.success : colors.primary } }, packagePhoto ? t("adght_llizala", { name: packagePhoto.name }) : t("er_idafa_swra")),
                        React.createElement("span", { className: "text-[10px] mt-0.5", style: { color: colors.textMuted } }, t("tsaad_alsayq_walidara_ala"))),
                    React.createElement(Card, { style: { padding: 14 } },
                        React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs mb-1`, style: { color: colors.textMuted } },
                            React.createElement("span", null,
                                t("er_mn"),
                                t(ERSAL_ORIGIN_CITY_KEY),
                                t("er_ila"),
                                city.name)),
                        React.createElement("div", { className: `flex ${rowStart()} justify-between text-sm font-extrabold`, style: { color: colors.text } },
                            React.createElement("span", null, t("alijmaly")),
                            React.createElement("span", null,
                                total.toLocaleString(loc()),
                                t("w_sdg_sp")))),
                    React.createElement(Button, { label: `تأكيد الطلب • ادفع ${total.toLocaleString(loc())} ج.س ${paymentTiming === "pickup" || !needsDriverConfirm ? t("er_and_alastlam") : t("er_and_altslym")}`, disabled: !packagePhoto, onPress: () => {
                            const stagesData = ersalBuildStages(paymentTiming, paymentMethod, city.name, deliveryMethod);
                            onCreateShipment({
                                destination: city.name, category: type.label, categoryKey: type.key,
                                weight: weightNum, dimensions, handlingKeys, photoName: packagePhoto === null || packagePhoto === void 0 ? void 0 : packagePhoto.name,
                                total, stagesData,
                                contentDescription, shipmentReference,
                                recipientName, recipientPhone,
                                declaredValue: Number(declaredValue) || 0,
                                insured: insuranceEnabled, insuranceFee,
                                deliveryWindow: deliveryMethod === "address" ? deliveryWindow : null,
                            });
                            setShipFlowView("goods");
                            setWeight("");
                            setDimensions({ height: "", width: "", length: "" });
                            setPackagePhoto(null);
                            setHandlingKeys(["normal"]);
                            setInsuranceEnabled(false);
                            setDeclaredValue("");
                            setDeliveryWindow(null);
                            setContentDescription("");
                            setShipmentReference("");
                            setRecipientName("");
                            setRecipientPhone("");
                            setMainTab("track");
                        }, className: "mt-4" }),
                    needsDriverConfirm && (React.createElement("p", { className: "text-[10px] text-center mt-2", style: { color: colors.textMuted } },
                        t("er_ytm_takyd"),
                        paymentTiming === "pickup" ? t("er_and_alastlam") : t("er_and_altslym"))),
                    !packagePhoto && React.createElement("p", { className: "text-[11px] font-bold text-center mt-2", style: { color: colors.danger } }, t("yjb_irfaq_swra_altrd")))));
        }
        if (mainTab === "track") {
            if (viewingProofId) {
                const s = shipments.find((sh) => sh.id === viewingProofId);
                return React.createElement(ErsalProofOfDeliveryScreen, { shipment: s, onBack: () => setViewingProofId(null) });
            }
            if (callingDriverFor) {
                const s = shipments.find((sh) => sh.id === callingDriverFor);
                const driver = s.stageIdx <= s.pickupEndIdx ? s.pickupDriver : s.deliveryDriver;
                return React.createElement(CallOverlay, { contactName: (driver === null || driver === void 0 ? void 0 : driver.name) || t("er_almndwb"), callType: "audio", onEnd: () => setCallingDriverFor(null) });
            }
            return (React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                React.createElement("h2", { className: "text-lg font-extrabold mb-3", style: { color: colors.text } }, t("alshhnat")),
                React.createElement("div", { className: "relative mb-3" },
                    React.createElement("input", { dir: "ltr", value: shipmentSearchQuery, onChange: (e) => setShipmentSearchQuery(e.target.value), placeholder: t("abhth_brqm_alttba_aw"), className: `w-full border rounded-xl ${pe("9")} ${ps("3")} py-2.5 text-sm`, style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.card } }),
                    React.createElement(Search, { size: 15, color: colors.textMuted, style: { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" } })),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-3 overflow-x-auto pb-1` }, [
                    { key: "all", label: t("er_alkl") },
                    { key: "active", label: t("er_nshta") },
                    { key: "delivered", label: t("er_mslma") },
                    { key: "failed", label: t("er_fshlt") },
                ].map((f) => (React.createElement("button", { key: f.key, onClick: () => setShipmentStatusFilter(f.key), className: "rounded-full border px-3 py-1.5 shrink-0", style: { borderColor: shipmentStatusFilter === f.key ? colors.primary : colors.border, backgroundColor: shipmentStatusFilter === f.key ? colors.primary : "transparent" } },
                    React.createElement("span", { className: "text-xs font-bold", style: { color: shipmentStatusFilter === f.key ? "#fff" : colors.text } }, f.label))))),
                shipments.length === 0 && React.createElement(EmptyState, { icon: Truck, label: t("la_twjd_shhnat_bad") }),
                shipments.length > 0 && filteredShipments.length === 0 && React.createElement(EmptyState, { icon: Search, label: t("ma_fyh_shhnat_ttabq") }),
                filteredShipments.map((s) => {
                    var _a, _b;
                    const stageIdx = s.stageIdx;
                    const stages = s.stages;
                    const isDelivered = stageIdx >= stages.length - 1;
                    // النموذج الحقيقي: سائق الاستلام يظهر حتى وصول الشحنة لمركز
                    // الخرطوم، بعدها فترة انتقال بلا سائق فردي (عربة الشركة)، ثم
                    // سائق التسليم (شخص مختلف تمامًا) من نقطة deliveryStartIdx فصاعدًا
                    const activeDriver = stageIdx <= s.pickupEndIdx ? s.pickupDriver : stageIdx >= s.deliveryStartIdx ? s.deliveryDriver : null;
                    const activeDriverLabel = stageIdx <= s.pickupEndIdx ? t("er_sayq_alastlam") : t("er_sayq_altslym");
                    const daysSinceFail = s.failedAt ? Math.floor((Date.now() - s.failedAt) / (1000 * 60 * 60 * 24)) : 0;
                    const storageDays = Math.max(0, daysSinceFail - ERSAL_STORAGE_GRACE_DAYS);
                    const storageFee = storageDays * (ERSAL_STORAGE_FEES[s.categoryKey] || 1500);
                    return (React.createElement(Card, { key: s.id, style: { padding: 0, overflow: "hidden" } },
                        React.createElement("div", { className: "p-4", style: {
                                background: s.cancelled
                                    ? colors.border
                                    : s.failed
                                        ? `linear-gradient(135deg, ${colors.danger}, #8B2E22)`
                                        : isDelivered
                                            ? `linear-gradient(135deg, ${colors.success}, #145C33)`
                                            : `linear-gradient(135deg, ${colors.primary}, ${colors.primaryDark})`,
                            } },
                            React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-1` },
                                React.createElement("span", { className: "text-sm font-extrabold font-mono text-white" }, s.id),
                                React.createElement(Badge, { size: "sm", variant: "neutral", label: s.cancelled ? t("er_alghyt") : s.failed ? t("er_fshl_altslym") : isDelivered ? t("er_tm_altslym") : t("er_qyd_altwsyl") })),
                            React.createElement("div", { className: "text-xs", style: { color: "#ffffffdd" } },
                                s.category,
                                " \u2190 ",
                                s.destination),
                            s.recipientName && (React.createElement("div", { className: "text-[10px] mt-0.5", style: { color: "#ffffffcc" } },
                                t("er_almstlm"),
                                s.recipientName)),
                            s.insured && (React.createElement("div", { className: `flex ${rowStart()} items-center gap-1 mt-1` },
                                React.createElement(ShieldCheck, { size: 11, color: "#fff" }),
                                React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#fff" } },
                                    t("er_mwmna_bqyma"),
                                    s.declaredValue.toLocaleString(loc()),
                                    t("w_sdg_sp")))),
                            s.deliveryWindow && (React.createElement("div", { className: `flex ${rowStart()} items-center gap-1 mt-1` },
                                React.createElement(Clock, { size: 11, color: "#fff" }),
                                React.createElement("span", { className: "text-[10px] font-bold", style: { color: "#fff" } },
                                    t("er_altslym_"), (_a = ERSAL_DELIVERY_WINDOWS.find((w) => w.key === s.deliveryWindow)) === null || _a === void 0 ? void 0 :
                                    _a.label))),
                            !isDelivered && !s.failed && !s.cancelled && (React.createElement("div", { className: "text-[11px] mt-1 font-bold", style: { color: "#fff" } }, stages[stageIdx]))),
                        React.createElement("div", { className: "p-4" },
                            React.createElement("div", { className: "text-xs mb-2", style: { color: colors.textMuted } },
                                s.total.toLocaleString(loc()),
                                t("w_sdg_sp")),
                            !isDelivered && !s.failed && !s.cancelled && (React.createElement(AnimatedTrackingMap, { progress: stageIdx / (stages.length - 1), icon: Truck, pickup: ERSAL_ORIGIN_POINT, destination: ERSAL_CITIES.find((c) => c.name === s.destination) || { x: 85, y: 20 } })),
                            !s.failed && (React.createElement("div", { className: `flex ${rowStart()} gap-1 mb-2 mt-2` }, stages.map((st, i) => (React.createElement("div", { key: i, className: "flex-1 h-1.5 rounded-full", style: { backgroundColor: stageIdx >= i ? colors.primary : colors.border } }))))),
                            activeDriver && !s.failed && (React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-2` },
                                React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } },
                                    activeDriverLabel,
                                    ": ",
                                    activeDriver.name,
                                    " \u00B7 ",
                                    activeDriver.vehicle,
                                    " \u00B7 ",
                                    activeDriver.plate),
                                React.createElement("button", { "aria-label": t("atsal"), onClick: () => setCallingDriverFor(s.id), className: "w-7 h-7 rounded-full flex items-center justify-center shrink-0", style: { backgroundColor: colors.primaryLight } },
                                    React.createElement(Phone, { size: 12, color: colors.primary })))),
                            !activeDriver && stageIdx > s.pickupEndIdx && stageIdx < s.deliveryStartIdx && !s.failed && (React.createElement("div", { className: "text-[11px] mb-2", style: { color: colors.textMuted } }, t("arba_alshrka_nql_byn"))),
                            s.failed && (() => {
                                const daysRemaining = Math.max(0, ERSAL_RETURN_DEADLINE_DAYS - daysSinceFail);
                                const isReturned = daysSinceFail >= ERSAL_RETURN_DEADLINE_DAYS && s.pendingChoice !== "pickup_confirmed";
                                if (isReturned) {
                                    return (React.createElement("div", { className: `rounded-xl p-3 mb-2 flex ${rowStart()} items-center gap-2`, style: { backgroundColor: isDark ? "#2A2A2A" : "#EFEFEF" } },
                                        React.createElement(RotateCcw, { size: 16, color: colors.textMuted }),
                                        React.createElement("span", { className: "text-xs font-bold", style: { color: colors.textMuted } },
                                            t("er_mrtjaa"),
                                            ERSAL_RETURN_DEADLINE_DAYS,
                                            t("er_ayam_bdwn"))));
                                }
                                return (React.createElement("div", { className: "rounded-xl p-3 mb-2", style: { backgroundColor: isDark ? "#3A1F1F" : "#FBE9E7" } },
                                    React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 mb-1.5` },
                                        React.createElement(AlertTriangle, { size: 14, color: colors.danger }),
                                        React.createElement("span", { className: "text-xs font-extrabold", style: { color: colors.danger } }, t("ijra_mtlwb"))),
                                    React.createElement("div", { className: "text-[11px] font-bold mb-2", style: { color: colors.danger } }, storageDays > 0
                                        ? `رسوم تخزين مستحقة: ${storageDays} يوم × ${(ERSAL_STORAGE_FEES[s.categoryKey] || 1500).toLocaleString(loc())} = ${storageFee.toLocaleString(loc())} ج.س`
                                        : t("ftra_smah_ayam_qbl", { ERSAL_STORAGE_GRACE_DAYS })),
                                    React.createElement("div", { className: "text-[11px] mb-2", style: { color: colors.textMuted } },
                                        t("mtbqy"),
                                        React.createElement("b", { style: { color: colors.danger } }, daysRemaining),
                                        " \u0645\u0646 ",
                                        ERSAL_RETURN_DEADLINE_DAYS,
                                        t("er_ayam_qbl")),
                                    React.createElement("div", { className: `flex ${rowStart()} gap-1 mb-3` }, Array.from({ length: ERSAL_RETURN_DEADLINE_DAYS }).map((_, i) => (React.createElement("div", { key: i, className: "flex-1 h-1.5 rounded-full", style: { backgroundColor: i < daysSinceFail ? colors.danger : colors.border } })))),
                                    s.pendingChoice === "pickup_confirmed" ? (React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 rounded-xl p-2`, style: { backgroundColor: colors.card } },
                                        React.createElement(MapPin, { size: 13, color: colors.success }),
                                        React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.success } },
                                            t("er_bantzark"),
                                            s.destination,
                                            t("er_ymknk")))) : changingAddressFor === s.id ? (React.createElement("div", { className: "rounded-xl p-2", style: { backgroundColor: colors.card } },
                                        React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: newAddressInput, onChange: (e) => setNewAddressInput(e.target.value), placeholder: t("alanwan_aljdyd_baltfsyl"), className: "w-full border rounded-xl px-3 py-2 text-xs mb-2", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.bg } }),
                                        React.createElement("div", { className: "text-[10px] font-bold mb-2", style: { color: colors.accent } },
                                            "+ ",
                                            ERSAL_REDELIVERY_FEE.toLocaleString(loc()),
                                            t("er_rswm_iaada")),
                                        React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                                            React.createElement(Button, { label: t("takyd_alanwan_aljdyd"), disabled: !newAddressInput.trim(), onPress: () => { onChangeAddress(s.id, newAddressInput.trim()); setChangingAddressFor(null); setNewAddressInput(""); }, style: { flex: 1 } }),
                                            React.createElement("button", { onClick: () => setChangingAddressFor(null), className: "text-xs font-bold px-3", style: { color: colors.textMuted } }, t("ilgha"))))) : (React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                                        React.createElement(Button, { label: t("tghyyr_anwan_altslym"), onPress: () => setChangingAddressFor(s.id), style: { flex: 1 } }),
                                        React.createElement(Button, { label: t("alastlam_mn_almrkz"), variant: "outline", onPress: () => onConfirmPickup(s.id), style: { flex: 1 } }))),
                                    React.createElement("button", { onClick: () => onSimulateDays(s.id, 1), className: "w-full text-center mt-2 text-[10px] font-bold underline", style: { color: colors.textMuted } }, t("mhakaa_tqdym_ywm_wahd"))));
                            })(),
                            isDelivered && !s.failed && (React.createElement(React.Fragment, null,
                                React.createElement("div", { className: `flex ${rowStart()} gap-2 mt-1` },
                                    React.createElement(Button, { label: t("ard_ithbat_altslym"), variant: "outline", onPress: () => setViewingProofId(s.id), style: { flex: 1 } }),
                                    React.createElement(Button, { icon: RotateCcw, label: t("iaada_altlb"), onPress: () => onReorderShipment(s), style: { flex: 1 } })),
                                !s.courierRating ? (React.createElement("div", { className: "rounded-xl border mt-2 p-3", style: { borderColor: colors.border, backgroundColor: colors.card } },
                                    React.createElement("p", { className: "text-xs font-bold text-center mb-2", style: { color: colors.text } },
                                        t("er_kyf_kant"), (_b = s.deliveryDriver) === null || _b === void 0 ? void 0 :
                                        _b.name,
                                        t("er_swal")),
                                    React.createElement("div", { className: `flex ${rowStart()} justify-center gap-1.5` }, [1, 2, 3, 4, 5].map((n) => (React.createElement("button", { "aria-label": t("almfdla"), key: n, onClick: () => onRateCourier(s.id, n) },
                                        React.createElement(Star, { size: 22, color: colors.accent, fill: "none" }))))))) : (React.createElement("div", { className: `flex ${rowStart()} items-center justify-center gap-1 mt-2` },
                                    [1, 2, 3, 4, 5].map((n) => (React.createElement(Star, { key: n, size: 14, color: colors.accent, fill: n <= s.courierRating ? colors.accent : "none" }))),
                                    React.createElement("span", { className: `text-[10px] ${me("1")}`, style: { color: colors.textMuted } }, t("qymt_hdha_altslym")))))),
                            !isDelivered && !s.failed && !s.cancelled && (React.createElement("div", { className: `flex ${rowStart()} flex-wrap gap-1.5` }, ERSAL_FAILURE_REASON_KEYS.map((reasonKey) => (React.createElement("button", { key: reasonKey, onClick: () => onMarkFailed(s.id, t(reasonKey)), className: "text-[10px] rounded-full border px-2 py-1", style: { borderColor: colors.border, color: colors.textMuted } },
                                t("er_tadhr"),
                                t(reasonKey)))))),
                            !s.cancelled && (React.createElement("div", { className: `flex ${rowStart()} gap-2 mt-2` },
                                React.createElement("button", { onClick: async () => {
                                        const text = `تتبّع شحنتي بسوا\nرقم الشحنة: ${s.id}\nالحالة: ${s.failed ? t("er_fshl_altslym") : stages[stageIdx]}\nالوجهة: ${s.destination}`;
                                        if (navigator.share) {
                                            try {
                                                await navigator.share({ text });
                                            }
                                            catch (err) { }
                                        }
                                        else {
                                            await copyText(text);
                                            showToast(t("tm_nskh_rabt_alttba"), "success");
                                        }
                                    }, className: `flex-1 flex ${rowStart()} items-center justify-center gap-1.5 rounded-xl py-2 border`, style: { borderColor: colors.primary } },
                                    React.createElement(Share2, { size: 13, color: colors.primary }),
                                    React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.primary } }, t("msharka_alttba"))),
                                !isDelivered && !s.failed && stageIdx === 0 && (confirmingCancelId === s.id ? (React.createElement("div", { className: `flex-1 flex ${rowStart()} gap-1.5` },
                                    React.createElement("button", { onClick: () => { onCancelShipment(s.id); setConfirmingCancelId(null); }, className: "flex-1 rounded-xl py-2", style: { backgroundColor: colors.danger } },
                                        React.createElement("span", { className: "text-[11px] font-bold text-white" }, t("takyd"))),
                                    React.createElement("button", { onClick: () => setConfirmingCancelId(null), className: "flex-1 rounded-xl py-2 border", style: { borderColor: colors.border } },
                                        React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.text } }, t("traja"))))) : (React.createElement("button", { onClick: () => setConfirmingCancelId(s.id), className: "flex-1 rounded-xl py-2 border", style: { borderColor: colors.danger } },
                                    React.createElement("span", { className: "text-[11px] font-bold", style: { color: colors.danger } }, t("ilgha_alshhna"))))))))));
                })));
        }
        if (mainTab === "billing") {
            const totalCollected = shipments.filter((s) => s.stageIdx >= s.stages.length - 1 && !s.failed).reduce((sum, s) => sum + s.total, 0);
            const totalPending = shipments.filter((s) => s.stageIdx < s.stages.length - 1 || s.failed).reduce((sum, s) => sum + s.total, 0);
            const viewingInvoice = viewingInvoiceId ? shipments.find((s) => s.id === viewingInvoiceId) : null;
            if (viewingInvoice) {
                const collected = viewingInvoice.stageIdx >= viewingInvoice.stages.length - 1 && !viewingInvoice.failed;
                return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
                    React.createElement(TopBar, { title: t("tfasyl_alfatwra"), onBack: () => setViewingInvoiceId(null) }),
                    React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                        React.createElement(Card, null,
                            React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-2` },
                                React.createElement("span", { className: "text-sm font-bold font-mono", style: { color: colors.text } }, viewingInvoice.id),
                                React.createElement(Badge, { size: "sm", variant: collected ? "success" : "warning", label: collected ? t("er_tm_thsylh") : t("er_qyd_althsyl") })),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs py-1.5 border-t`, style: { borderColor: colors.border } },
                                React.createElement("span", { style: { color: colors.textMuted } }, t("alsnf")),
                                React.createElement("span", { style: { color: colors.text } }, viewingInvoice.category)),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs py-1.5 border-t`, style: { borderColor: colors.border } },
                                React.createElement("span", { style: { color: colors.textMuted } }, t("alwjha")),
                                React.createElement("span", { style: { color: colors.text } }, viewingInvoice.destination)),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-xs py-1.5 border-t`, style: { borderColor: colors.border } },
                                React.createElement("span", { style: { color: colors.textMuted } }, t("alwzn")),
                                React.createElement("span", { style: { color: colors.text } },
                                    viewingInvoice.weight,
                                    t("er_kjm_sfx"))),
                            React.createElement("div", { className: `flex ${rowStart()} justify-between text-sm py-1.5 border-t font-bold`, style: { borderColor: colors.border } },
                                React.createElement("span", { style: { color: colors.textMuted } }, t("alijmaly")),
                                React.createElement("span", { style: { color: colors.primary } },
                                    viewingInvoice.total.toLocaleString(loc()),
                                    t("w_sdg_sp")))),
                        React.createElement("button", { onClick: async () => {
                                const text = `فاتورة سوا إرسال\nرقم الشحنة: ${viewingInvoice.id}\nالصنف: ${viewingInvoice.category} ← ${viewingInvoice.destination}\nالحالة: ${collected ? t("er_tm_thsylh") : t("er_qyd_althsyl")}\nالإجمالي: ${viewingInvoice.total.toLocaleString(loc())} ج.س`;
                                if (navigator.share) {
                                    try {
                                        await navigator.share({ text });
                                    }
                                    catch (err) { }
                                }
                                else
                                    await copyText(text);
                            }, className: `w-full flex ${rowStart()} items-center justify-center gap-2 rounded-xl p-3 border mt-3`, style: { borderColor: colors.primary } },
                            React.createElement(Share2, { size: 16, color: colors.primary }),
                            React.createElement("span", { className: "text-sm font-bold", style: { color: colors.primary } }, t("msharka_alfatwra"))))));
            }
            return (React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                React.createElement("h2", { className: "text-lg font-extrabold mb-3", style: { color: colors.text } }, t("alfwatyr")),
                React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-4` },
                    React.createElement(Card, { style: { flex: 1, padding: 12 } },
                        React.createElement("div", { className: "text-[11px]", style: { color: colors.textMuted } }, t("tm_thsylh")),
                        React.createElement("div", { className: "text-base font-extrabold mt-1", style: { color: colors.success } },
                            totalCollected.toLocaleString(loc()),
                            t("w_sdg_sp"))),
                    React.createElement(Card, { style: { flex: 1, padding: 12 } },
                        React.createElement("div", { className: "text-[11px]", style: { color: colors.textMuted } }, t("qyd_althsyl")),
                        React.createElement("div", { className: "text-base font-extrabold mt-1", style: { color: colors.accent } },
                            totalPending.toLocaleString(loc()),
                            t("w_sdg_sp")))),
                shipments.map((s) => {
                    const collected = s.stageIdx >= s.stages.length - 1 && !s.failed;
                    return (React.createElement("button", { key: s.id, onClick: () => setViewingInvoiceId(s.id), className: `w-full ${textStart()} block` },
                        React.createElement(Card, { className: `flex ${rowStart()} items-center justify-between` },
                            React.createElement("span", { className: "text-xs", style: { color: colors.text } },
                                s.id,
                                " \u2014 ",
                                s.category,
                                " \u2190 ",
                                s.destination),
                            React.createElement(Badge, { size: "sm", variant: collected ? "success" : "warning", label: collected ? t("er_tm_thsylh") : t("er_qyd_althsyl") }))));
                })));
        }
        if (mainTab === "account") {
            if (accountSubView === "corporateStatement")
                return React.createElement(ErsalCorporateStatementScreen, { shipments: shipments, onBack: () => setAccountSubView(null) });
            if (accountSubView === "bulkUpload")
                return React.createElement(ErsalBulkUploadScreen, { onBulkCreate: onBulkCreateShipments, onBack: () => setAccountSubView(null) });
            if (accountSubView === "savedLocations")
                return (React.createElement(ErsalSavedLocationsScreen, { pickupLocations: savedPickupLocations, deliveryLocations: savedDeliveryLocations, onAddLocation: addSavedLocation, onDeleteLocation: deleteSavedLocation, onBack: () => setAccountSubView(null) }));
            return (React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
                React.createElement("h2", { className: "text-lg font-extrabold mb-4", style: { color: colors.text } }, t("alhsab")),
                React.createElement(Card, null,
                    React.createElement("div", { className: `flex ${rowStart()} items-center gap-1.5 mb-2` },
                        React.createElement(Palette, { size: 14, color: colors.primary }),
                        React.createElement("span", { className: "text-sm font-bold", style: { color: colors.text } }, t("mzhr_irsal"))),
                    React.createElement("div", { className: `flex ${rowStart()} gap-2` }, Object.entries(ERSAL_THEMES).map(([key, etheme]) => (React.createElement("button", { key: key, onClick: () => setErsalThemeKey(key), className: "flex-1 flex flex-col items-center gap-1 rounded-xl border-2 p-2", style: { borderColor: ersalThemeKey === key ? etheme.primary : colors.border } },
                        React.createElement("span", { className: "w-7 h-7 rounded-full", style: { backgroundColor: etheme.primary } }),
                        React.createElement("span", { className: "text-[10px] font-bold", style: { color: colors.text } }, etheme.label)))))),
                [
                    { key: "corporateStatement", label: t("er_kshf_hsab"), icon: BarChart3 },
                    { key: "bulkUpload", label: t("er_rfa_bjmla"), icon: Download },
                    { key: "savedLocations", label: t("er_almwaqa"), icon: MapPin },
                ].map((item) => (React.createElement("button", { "aria-label": t("altaly"), key: item.key, onClick: () => setAccountSubView(item.key), className: `w-full flex ${rowStart()} items-center justify-between rounded-xl p-3.5 border mb-3`, style: { backgroundColor: colors.card, borderColor: colors.border } },
                    React.createElement(item.icon, { size: 18, color: colors.primary }),
                    React.createElement("span", { className: `flex-1 text-sm font-bold ${textStart()} ${ms("2")}`, style: { color: colors.text } }, item.label),
                    React.createElement(ChevronLeft, { size: 16, color: colors.textMuted, style: { transform: "scaleX(-1)" } }))))));
        }
        // home
        return (React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            React.createElement("h2", { className: "text-lg font-extrabold mb-1", style: { color: colors.text } }, t("sbah_alkhyr")),
            React.createElement(Card, { style: { padding: 14 } },
                React.createElement("p", { className: "text-sm font-bold mb-2", style: { color: colors.text } }, t("jahz_lnql_shy")),
                React.createElement(Button, { icon: Package, label: t("shhna_jdyda"), onPress: () => { setMainTab("ship"); setShipFlowView("goods"); } })),
            React.createElement(Card, { style: { padding: 12 } },
                React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("ttba_ay_shhna_brqmha")),
                React.createElement("div", { className: `flex ${rowStart()} gap-2` },
                    React.createElement("input", { dir: "ltr", value: trackingNumber, onChange: (e) => setTrackingNumber(e.target.value), placeholder: "FR-10462", className: "flex-1 border rounded-xl px-3 py-2 text-sm", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.bg } }),
                    React.createElement(Button, { label: t("ttba"), onPress: () => setMainTab("track"), style: { width: 90 } }))),
            React.createElement("div", { className: `flex ${rowStart()} gap-2 mb-3` },
                React.createElement(Card, { style: { flex: 1, padding: 10, textAlign: "center" } },
                    React.createElement("div", { className: "text-lg font-extrabold", style: { color: colors.primary } }, onTimeCount),
                    React.createElement("div", { className: "text-[10px]", style: { color: colors.textMuted } }, t("alaltzam_balwqt"))),
                React.createElement(Card, { style: { flex: 1, padding: 10, textAlign: "center" } },
                    React.createElement("div", { className: "text-lg font-extrabold", style: { color: colors.primary } }, activeShipments.length),
                    React.createElement("div", { className: "text-[10px]", style: { color: colors.textMuted } }, t("nshta"))),
                React.createElement(Card, { style: { flex: 1, padding: 10, textAlign: "center" } },
                    React.createElement("div", { className: "text-lg font-extrabold", style: { color: colors.primary } }, shipments.length),
                    React.createElement("div", { className: "text-[10px]", style: { color: colors.textMuted } }, t("alijmaly")))),
            React.createElement("h4", { className: "text-sm font-extrabold mb-2", style: { color: colors.text } }, t("alshhnat")),
            shipments.length === 0 && React.createElement(EmptyState, { icon: Truck, label: t("la_twjd_shhnat_bad_2") }),
            shipments.slice(0, 3).map((s) => (React.createElement(Card, { key: s.id, className: `flex ${rowStart()} items-center justify-between` },
                React.createElement("span", { className: "text-xs", style: { color: colors.text } },
                    s.category,
                    " \u2190 ",
                    s.destination),
                React.createElement(Badge, { size: "sm", variant: s.stageIdx >= s.stages.length - 1 ? "success" : "warning", label: s.stages[s.stageIdx] }))))));
    }
    // الشاشات الفرعية (كشف الحساب/الرفع بالجملة/المواقع المحفوظة) عندها
    // TopBar كامل خاص بها فيه زر رجوع صحيح لمستوى t("er_alhsab") — لو عرضنا شريط
    // "إرسال إكسبريس" الخارجي فوقها كمان، بنحصل شريطين عنوان متراكبين، وزر
    // الرجوع الأول اللي يلقاه المستخدم يطلعه من إرسال كله بدل يرجعه خطوة وحدة
    const hasOwnFullScreenHeader = (mainTab === "account" && accountSubView !== null) || (mainTab === "track" && viewingProofId !== null);
    if (hasOwnFullScreenHeader) {
        return renderContent();
    }
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("irsal_iksbrys"), onBack: onBack }),
        renderContent(),
        // ⚠️ اتجاه الشريط ثابت لا يتبع اللغة: خاصية dir على <html> تقلب المحور
                // أصلاً، فتبديل flex-direction بحسب اللغة يُلغي القلب ويُبقي الترتيب
                // الفيزيائي كما هو في اللغتين. الثابت المختار هو ما يُنتج ترتيب
                // العربية الحالي؛ والإنجليزية تصير مرآته تلقائياً.
                showBottomNav && accountSubView === null && (React.createElement("div", { className: "flex flex-row-reverse border-t", style: { borderColor: colors.border, backgroundColor: colors.card } }, ERSAL_BOTTOM_NAV.map((item) => {
            const active = mainTab === item.key;
            return (React.createElement("button", { key: item.key, onClick: () => { setMainTab(item.key); if (item.key === "ship")
                    setShipFlowView("goods"); }, className: "flex-1 flex flex-col items-center py-2" },
                React.createElement(item.icon, { size: 17, color: active ? colors.primary : colors.textMuted }),
                React.createElement("span", { className: "text-[9px] mt-0.5", style: { color: active ? colors.primary : colors.textMuted, fontWeight: active ? 700 : 400 } }, item.label)));
        }))),
        mapModalFor && (React.createElement(MapPickerModal, { title: mapModalFor === "pickup" ? t("er_thdyd_astlam") : t("er_thdyd_tslym"), initialPoint: mapModalFor === "pickup" ? pickupPoint : deliveryPoint, onClose: () => setMapModalFor(null), onConfirm: (point) => {
                // نولّد وصف إحداثيات تقريبي واقعي من موقع الدبّوس النسبي — نفس
                // أسلوب "عرض الإحداثيات التقريبية" الموثّق بالمنصة الحقيقية
                const lat = (15.5 + (point.y / 100) * 0.4).toFixed(4);
                const lng = (32.5 + (point.x / 100) * 0.4).toFixed(4);
                const desc = t("mwqa_mhdd_shmala_shrqa", { lat, lng });
                if (mapModalFor === "pickup") {
                    setPickupPoint(point);
                    setPickupAddressText(desc);
                }
                else {
                    setDeliveryPoint(point);
                    setDeliveryAddressText(desc);
                }
                setMapModalFor(null);
            } }))));
}
// إثبات التسليم — توقيع حقيقي (رسم فعلي بالسحب على canvas، مو محاكاة)،
// اسم المستلم، تقييم تفاعلي، وتحميل إيصال JSON حقيقي
function SignaturePad({ onSigned }) {
    const { colors } = useTheme();
    const canvasRef = useRef(null);
    const drawingRef = useRef(false);
    const [hasSignature, setHasSignature] = useState(false);
    function getPos(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - rect.left, y: clientY - rect.top };
    }
    function startDraw(e) {
        drawingRef.current = true;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const { x, y } = getPos(e, canvas);
        ctx.beginPath();
        ctx.moveTo(x, y);
    }
    function draw(e) {
        if (!drawingRef.current)
            return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const { x, y } = getPos(e, canvas);
        ctx.lineTo(x, y);
        ctx.strokeStyle = colors.primary;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
        if (!hasSignature)
            setHasSignature(true);
    }
    function endDraw() {
        if (drawingRef.current && hasSignature) {
            onSigned(canvasRef.current.toDataURL("image/png"));
        }
        drawingRef.current = false;
    }
    function clear() {
        const canvas = canvasRef.current;
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        setHasSignature(false);
        onSigned(null);
    }
    return (React.createElement("div", null,
        React.createElement("canvas", { ref: canvasRef, width: 300, height: 140, className: "w-full rounded-xl border", style: { borderColor: colors.border, backgroundColor: "#fff", touchAction: "none" }, onMouseDown: startDraw, onMouseMove: draw, onMouseUp: endDraw, onMouseLeave: endDraw, onTouchStart: startDraw, onTouchMove: draw, onTouchEnd: endDraw }),
        hasSignature && (React.createElement("button", { onClick: clear, className: "text-[11px] font-bold underline mt-1", style: { color: colors.primary } }, t("msh_waltwqya_mn_jdyd")))));
}
function ErsalProofOfDeliveryScreen({ shipment, onBack }) {
    var _a;
    const { colors } = useTheme();
    const proof = shipment.proofOfDelivery;
    function downloadReceipt() {
        const payload = {
            trackingNumber: shipment.id,
            destination: shipment.destination,
            category: shipment.category,
            total: shipment.total,
            recipientName: proof === null || proof === void 0 ? void 0 : proof.recipientName,
            capturedAt: proof ? new Date(proof.capturedAt).toISOString() : null,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `receipt-${shipment.id}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("ithbat_altslym"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            React.createElement("div", { className: "flex flex-col items-center mb-4" },
                React.createElement("div", { className: "w-16 h-16 rounded-full flex items-center justify-center mb-2", style: { backgroundColor: colors.primaryLight } },
                    React.createElement(Check, { size: 30, color: colors.success })),
                React.createElement("h3", { className: "text-base font-extrabold", style: { color: colors.text } }, t("tm_altslym")),
                React.createElement("span", { className: "text-xs font-mono mt-1", style: { color: colors.textMuted } }, shipment.id)),
            shipment.photoName && (React.createElement(Card, { className: `flex ${rowStart()} items-center gap-2 mb-3` },
                React.createElement(Camera, { size: 15, color: colors.primary }),
                React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } },
                    t("er_swra_altrd"),
                    shipment.photoName))),
            proof ? (React.createElement(React.Fragment, null,
                React.createElement("p", { className: "text-[11px] mb-2", style: { color: colors.textMuted } },
                    t("er_altqtha"), (_a = shipment.deliveryDriver) === null || _a === void 0 ? void 0 :
                    _a.name,
                    t("er_bjhazh")),
                React.createElement(Card, { className: "mb-3" },
                    React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-1` },
                        React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, t("astlmh")),
                        React.createElement("span", { className: "text-sm font-bold", style: { color: colors.text } }, proof.recipientName)),
                    React.createElement("div", { className: `flex ${rowStart()} items-center justify-between` },
                        React.createElement("span", { className: "text-xs", style: { color: colors.textMuted } }, t("wqt_alastlam")),
                        React.createElement("span", { className: "text-xs", style: { color: colors.text } }, new Date(proof.capturedAt).toLocaleString(loc(), { day: "numeric", month: "long", hour: "numeric", minute: "numeric" })))),
                React.createElement("label", { className: "text-xs font-bold mb-2 block", style: { color: colors.text } }, t("twqya_almstlm")),
                React.createElement(Card, { className: "mb-4" },
                    React.createElement("svg", { viewBox: "0 0 160 50", className: "w-full", style: { height: 60 } },
                        React.createElement("path", { d: proof.signaturePath, stroke: colors.text, strokeWidth: "2", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" }))))) : (React.createElement(Card, { className: "mb-4" },
                React.createElement("p", { className: "text-xs text-center", style: { color: colors.textMuted } }, t("byanat_alastlam_qyd_almzamna")))),
            React.createElement(Button, { icon: Download, label: t("thmyl_aliysal"), onPress: downloadReceipt, variant: "outline" }))));
}
function ErsalCorporateStatementScreen({ shipments, onBack }) {
    const { colors } = useTheme();
    const byMonth = {};
    shipments.forEach((s) => {
        const month = new Date(s.createdAt || Date.now()).toLocaleDateString(loc(), { month: "long", year: "numeric" });
        if (!byMonth[month])
            byMonth[month] = [];
        byMonth[month].push(s);
    });
    const months = Object.keys(byMonth);
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("kshf_hsab_alshrka"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            months.length === 0 && React.createElement(EmptyState, { icon: BarChart3, label: t("la_twjd_byanat_kshf") }),
            months.map((month) => {
                const monthTotal = byMonth[month].reduce((sum, s) => sum + s.total, 0);
                return (React.createElement(Card, { key: month },
                    React.createElement("div", { className: `flex ${rowStart()} items-center justify-between mb-2` },
                        React.createElement("span", { className: "text-sm font-bold", style: { color: colors.text } }, month),
                        React.createElement("span", { className: "text-sm font-extrabold", style: { color: colors.primary } },
                            monthTotal.toLocaleString(loc()),
                            t("w_sdg_sp"))),
                    React.createElement("span", { className: "text-[11px]", style: { color: colors.textMuted } },
                        byMonth[month].length,
                        t("er_shhna"))));
            }))));
}
function ErsalBulkUploadScreen({ onBulkCreate, onBack }) {
    const { colors } = useTheme();
    const [rows, setRows] = useState([]);
    const [fileName, setFileName] = useState(null);
    const fileInputRef = useRef(null);
    function handleFile(file) {
        setFileName(file.name);
        const reader = new FileReader();
        reader.onload = (e) => {
            const lines = e.target.result.trim().split("\n");
            const header = lines[0].split(",").map((h) => h.trim());
            const parsed = lines.slice(1).map((line) => {
                const cells = line.split(",").map((c) => c.trim());
                const row = {};
                header.forEach((h, i) => { row[h] = cells[i]; });
                return row;
            });
            setRows(parsed);
        };
        reader.readAsText(file);
    }
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("rfa_shhnat_baljmla"), onBack: onBack }),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            React.createElement("p", { className: "text-xs mb-3", style: { color: colors.textMuted } }, t("mlf_csv_baamda_destination")),
            React.createElement("input", { ref: fileInputRef, type: "file", accept: ".csv", className: "hidden", onChange: (e) => { var _a; const f = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0]; if (f)
                    handleFile(f); } }),
            React.createElement(Button, { label: fileName || t("er_akhtr_csv"), onPress: () => { var _a; return (_a = fileInputRef.current) === null || _a === void 0 ? void 0 : _a.click(); }, variant: "outline" }),
            rows.length > 0 && (React.createElement(React.Fragment, null,
                React.createElement("h4", { className: "text-xs font-extrabold mt-4 mb-2", style: { color: colors.text } },
                    t("er_maayna"),
                    rows.length,
                    t("er_sf")),
                rows.map((r, i) => (React.createElement(Card, { key: i, className: `flex ${rowStart()} items-center justify-between` },
                    React.createElement("span", { className: "text-xs", style: { color: colors.text } }, r.destination),
                    React.createElement("span", { className: "text-[10px]", style: { color: colors.textMuted } },
                        r.weight,
                        t("er_kghm"),
                        r.shipmentType)))),
                React.createElement(Button, { label: t("insha_shhna", { length: rows.length }), onPress: () => { onBulkCreate(rows); onBack(); }, className: "mt-3" }))))));
}
function ErsalSavedLocationsScreen({ pickupLocations, deliveryLocations, onAddLocation, onDeleteLocation, onBack }) {
    const { colors } = useTheme();
    const [tab, setTab] = useState("pickup");
    const [showAddForm, setShowAddForm] = useState(false);
    const [newLabel, setNewLabel] = useState("");
    const [newAddress, setNewAddress] = useState("");
    const list = tab === "pickup" ? pickupLocations : deliveryLocations;
    return (React.createElement("div", { className: "flex-1 min-h-0 flex flex-col" },
        React.createElement(TopBar, { title: t("almwaqa_almhfwza"), onBack: onBack, actions: React.createElement("button", { "aria-label": t("idafa"), onClick: () => setShowAddForm(!showAddForm), className: `${ms("2")}` },
                React.createElement(Plus, { size: 18, color: "#fff" })) }),
        React.createElement("div", { className: `flex ${rowStart()} border-b`, style: { borderColor: colors.border } },
            React.createElement("button", { onClick: () => setTab("pickup"), className: "flex-1 py-2.5 text-center", style: { borderBottomWidth: 2, borderBottomColor: tab === "pickup" ? colors.primary : "transparent" } },
                React.createElement("span", { className: "text-xs font-bold", style: { color: tab === "pickup" ? colors.primary : colors.textMuted } }, t("mwaqa_alastlam"))),
            React.createElement("button", { onClick: () => setTab("delivery"), className: "flex-1 py-2.5 text-center", style: { borderBottomWidth: 2, borderBottomColor: tab === "delivery" ? colors.primary : "transparent" } },
                React.createElement("span", { className: "text-xs font-bold", style: { color: tab === "delivery" ? colors.primary : colors.textMuted } }, t("mwaqa_altslym")))),
        showAddForm && (React.createElement("div", { className: "p-3 border-b", style: { borderColor: colors.border, backgroundColor: colors.card } },
            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: newLabel, onChange: (e) => setNewLabel(e.target.value), placeholder: t("asm_almwqa_mthal_almkhzn"), className: "w-full border rounded-xl px-3 py-2 text-xs mb-2", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.bg } }),
            React.createElement("input", { dir: isRTL() ? "rtl" : "ltr", value: newAddress, onChange: (e) => setNewAddress(e.target.value), placeholder: t("alanwan_altfsyly"), className: "w-full border rounded-xl px-3 py-2 text-xs mb-2", style: { borderColor: colors.border, color: colors.text, backgroundColor: colors.bg } }),
            React.createElement("button", { onClick: () => {
                    if (!newLabel.trim() || !newAddress.trim())
                        return;
                    onAddLocation(tab, newLabel.trim(), newAddress.trim());
                    setNewLabel("");
                    setNewAddress("");
                    setShowAddForm(false);
                }, disabled: !newLabel.trim() || !newAddress.trim(), className: "text-[11px] font-bold", style: { color: colors.primary } }, t("hfz_almwqa")))),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-4", style: { backgroundColor: colors.bg } },
            list.length === 0 && React.createElement(EmptyState, { icon: MapPin, label: t("la_twjd_mwaqa_mhfwza") }),
            list.map((loc) => (React.createElement(Card, { key: loc.id, className: `flex ${rowStart()} items-center gap-2` },
                React.createElement(MapPin, { size: 15, color: colors.primary }),
                React.createElement("div", { className: "flex-1" },
                    React.createElement("div", { className: "text-xs font-bold", style: { color: colors.text } }, loc.label),
                    React.createElement("div", { className: "text-[10px]", style: { color: colors.textMuted } }, loc.address)),
                React.createElement("button", { "aria-label": t("hdhf"), onClick: () => onDeleteLocation(tab, loc.id) },
                    React.createElement(Trash2, { size: 15, color: colors.danger }))))))));
}
// ============================================================================
// تاكسي سوا — بيانات حقيقية مستخرجة من الكود الأصلي
// ============================================================================
const TAXI_VEHICLE_TYPES = [
    { key: "economy", label: t("tx_iqtsady"), multiplier: 1, icon: "🚗", eta: "3", seats: 4 },
    { key: "comfort", label: t("tx_mryh"), multiplier: 1.4, icon: "🚙", eta: "5", seats: 4 },
    { key: "family", label: t("tx_aayly"), multiplier: 1.8, icon: "🚐", eta: "7", seats: 6 },
];
const TAXI_DRIVERS = {
    economy: [
        { name: "عمر عثمان", car: "تويوتا كامري أبيض", plate: "KH1 26626", rating: 4.9, gender: "male" },
        { name: "علي العوض", car: "هيونداي إلنترا فضي", plate: "KH2 1626", rating: 4.7, gender: "male" },
        { name: "هديل محمد", car: "كيا سيراتو أبيض", plate: "KH1 62626", rating: 4.9, gender: "female" },
    ],
    comfort: [
        { name: "محمد خالد", car: "تويوتا كامري XLE أسود", plate: "KH3 7982", rating: 4.9, gender: "male" },
        { name: "هديل محمد", car: "هوندا أكورد أبيض", plate: "KH3 7399", rating: 4.8, gender: "female" },
    ],
    family: [{ name: "عمر التوم", car: "جي إم سي يوكن أبيض", plate: "KH2 5417", rating: 4.8, gender: "male" }],
};
// نطاق وحدة: مفاتيح لا نصوص (انظر قاعدة t() خارج المكوّنات)
//@@sawa-part:6
