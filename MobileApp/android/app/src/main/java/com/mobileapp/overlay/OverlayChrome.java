package com.mobileapp.overlay;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.mobileapp.R;

/**
 * Shared chrome for the mission overlay's three surfaces (ALL_IS_FIXED #46): the initial
 * two-button prompt card (overlay_mission.xml, styled via {@code @color}/{@code @dimen} refs
 * that mirror the constants read here), {@link OverlayQuizHelper}, and
 * {@link OverlayTicTacToeHelper}. Colors/dimensions are never hardcoded here — they're read
 * from {@code values/colors.xml}/{@code values/dimens.xml}, the same resources the XML card
 * references directly, so there is exactly one place either surface's styling can drift from.
 *
 * <p>Insets are installed exactly once, on the window root ({@code overlay_root} — see
 * {@link OverlayWindowHelper#attach}), not by this class's container builders. Both
 * {@link OverlayQuizHelper#showQuiz} and {@link OverlayTicTacToeHelper#showGame} confirmed
 * to {@code removeAllViews()} on that same root and rebuild directly inside it (never
 * targeting a specific child by id), so the root's own background + inset padding survive
 * that transition without needing to be reinstalled — installing insets a second time here
 * would double-pad the content.
 */
public final class OverlayChrome {

    private OverlayChrome() {}

    /** Not specified by the brief ("holds briefly", not beatable by a fast second tap) — our
     * own chosen value, tuned on device. Not a citation to any spec. */
    public static final long ANSWER_FEEDBACK_HOLD_MS = 1000L;

    public enum OptionState {
        NEUTRAL,
        CORRECT,
        INCORRECT
    }

    // ---- Insets --------------------------------------------------------------------------

    /**
     * Installs system-bar inset padding on {@code target}. Re-fires automatically on every
     * relayout that changes insets (rotation included) — no {@code onConfigurationChanged}
     * override needed. Padding only changes where children lay out, not where {@code target}'s
     * own background paints, so a full-bleed background stays edge-to-edge underneath it.
     */
    public static void installInsetPadding(View target) {
        ViewCompat.setOnApplyWindowInsetsListener(
                target,
                (v, insets) -> {
                    Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    return WindowInsetsCompat.CONSUMED;
                });
        // Defensive nudge: some OEMs deliver insets late/zero on the very first frame for a
        // TYPE_APPLICATION_OVERLAY window (no Activity decor view to auto-fit it). Cheap,
        // idempotent — verify on-device whether it's actually needed on this ROM.
        ViewCompat.requestApplyInsets(target);
    }

    // ---- Max-width content column ---------------------------------------------------------

    /**
     * Clamps {@code card}'s width to {@code min(availableWidth, overlay_content_max_width)}
     * and keeps it that way across rotation. A width set once from {@link
     * android.util.DisplayMetrics} at construction is NOT recomputed by Android's ordinary
     * remeasure-on-rotation — the tree remeasures around a fixed {@code layout_width}, it
     * doesn't change what that fixed number is. The {@link View#addOnLayoutChangeListener}
     * below is what actually re-applies the clamp whenever {@code widthReferenceParent}'s
     * measured width changes (portrait/landscape, or a display-cutout inset change). The
     * initial synchronous call uses a screen-width estimate so there's no unclamped flash
     * before the first real layout pass, which then corrects it against the true padded width.
     */
    public static void applyMaxWidth(Context context, View card, View widthReferenceParent) {
        int maxWidthPx =
                context.getResources().getDimensionPixelSize(R.dimen.overlay_content_max_width);
        int screenWidthPx = context.getResources().getDisplayMetrics().widthPixels;
        setCardWidth(card, Math.min(screenWidthPx, maxWidthPx));

        widthReferenceParent.addOnLayoutChangeListener(
                (v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
                    int available = v.getWidth() - v.getPaddingLeft() - v.getPaddingRight();
                    if (available <= 0) {
                        return;
                    }
                    setCardWidth(card, Math.min(available, maxWidthPx));
                });
    }

    /** Guards on the card's OWN current width (F3) — only that comparison stops a redundant
     * second layout pass; comparing the parent's width to its previous width would not. */
    private static void setCardWidth(View card, int widthPx) {
        ViewGroup.LayoutParams lp = card.getLayoutParams();
        if (lp == null || lp.width == widthPx) {
            return;
        }
        lp.width = widthPx;
        card.setLayoutParams(lp);
    }

    // ---- Programmatic container (quiz / Tic-Tac-Toe only — the XML card builds its own
    //      equivalent structure directly, see overlay_mission.xml) -------------------------

    /**
     * Builds a {@code ScrollView(fillViewport) -> centering LinearLayout -> card} column and
     * attaches it to {@code parent} (the already full-bleed, already inset-padded overlay
     * root). Content shorter than the viewport centers for free via {@code fillViewport}+
     * {@code gravity=center}; taller content scrolls, reading as top-aligned. Returns the
     * card {@link LinearLayout} for the caller to populate.
     */
    public static LinearLayout buildCenteredScrollColumn(Context context, ViewGroup parent) {
        ScrollView scrollView = new ScrollView(context);
        scrollView.setFillViewport(true);

        LinearLayout centerColumn = new LinearLayout(context);
        centerColumn.setOrientation(LinearLayout.VERTICAL);
        centerColumn.setGravity(Gravity.CENTER);
        scrollView.addView(
                centerColumn,
                new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout card = buildCard(context);
        centerColumn.addView(
                card,
                new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        if (parent instanceof FrameLayout) {
            ((FrameLayout) parent)
                    .addView(
                            scrollView,
                            new FrameLayout.LayoutParams(
                                    FrameLayout.LayoutParams.MATCH_PARENT,
                                    FrameLayout.LayoutParams.MATCH_PARENT));
        } else {
            parent.addView(scrollView);
        }

        applyMaxWidth(context, card, centerColumn);
        return card;
    }

    private static LinearLayout buildCard(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.overlay_mission_card);
        int padding = context.getResources().getDimensionPixelSize(R.dimen.overlay_card_padding);
        card.setPadding(padding, padding, padding, padding);
        card.setElevation(dp(context, 12));
        return card;
    }

    // ---- Type-scale / color factories (quiz + Tic-Tac-Toe; the XML card styles its own
    //      id'd views directly via @color/@dimen refs) --------------------------------------

    public static TextView badgeView(Context context) {
        TextView tv = new TextView(context);
        tv.setText(context.getString(R.string.overlay_mission_badge));
        tv.setTextColor(ContextCompat.getColor(context, R.color.overlay_badge));
        setTextSizePx(tv, context, R.dimen.overlay_text_badge);
        tv.setTypeface(null, Typeface.BOLD);
        // ALL_IS_FIXED #54: MissionScreen.badgeText's real letterSpacing (1.2dp at 11sp) is the
        // only tracking value found anywhere in the app's real renders (QuizScreen/MissionScreen
        // otherwise carry no letterSpacing at all). RN's letterSpacing is dp; Android's
        // TextView#setLetterSpacing is em: 1.2 / 11 ~= 0.109em.
        tv.setLetterSpacing(0.109f);
        return tv;
    }

    /**
     * Quiz/Tic-Tac-Toe surfaces only. ALL_IS_FIXED #54, H1: this title sits above a question on
     * one combined overlay screen, unlike the app's two-step MissionScreen-then-QuizScreen flow,
     * so it must read as secondary -- sized from overlay_text_active_title (18sp, a constructed
     * value with no single real-app precedent), not overlay_text_title (26sp, reserved for the
     * XML prompt card, the overlay's actual one-screen analogue of MissionScreen).
     */
    public static TextView titleView(Context context, @Nullable String text) {
        TextView tv = new TextView(context);
        tv.setText(text != null ? text : "");
        tv.setTextColor(ContextCompat.getColor(context, R.color.overlay_title));
        setTextSizePx(tv, context, R.dimen.overlay_text_active_title);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setPadding(0, dp(context, 8), 0, 0);
        return tv;
    }

    public static TextView captionView(Context context) {
        TextView tv = new TextView(context);
        tv.setTextColor(ContextCompat.getColor(context, R.color.overlay_caption));
        setTextSizePx(tv, context, R.dimen.overlay_text_caption);
        return tv;
    }

    public static TextView progressCountView(Context context) {
        TextView tv = captionView(context);
        setTextSizePx(tv, context, R.dimen.overlay_text_progress_count);
        tv.setGravity(Gravity.CENTER_HORIZONTAL);
        return tv;
    }

    public static TextView questionView(Context context) {
        TextView tv = new TextView(context);
        tv.setTextColor(ContextCompat.getColor(context, R.color.overlay_title));
        setTextSizePx(tv, context, R.dimen.overlay_text_question);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setPadding(0, 0, 0, dp(context, 12));
        return tv;
    }

    public static Button optionButton(Context context, String text) {
        Button b = new Button(context);
        b.setText(text);
        b.setAllCaps(false);
        setTextSizePx(b, context, R.dimen.overlay_text_option);
        // ALL_IS_FIXED #54, G3: rounded drawable set ONCE at creation; setOptionState below only
        // re-tints it (setBackgroundTintList), never replaces it with setBackgroundColor -- that
        // would flatten the corners straight back to a rectangle on every recolor.
        b.setBackgroundResource(R.drawable.overlay_option_shape);
        setOptionState(b, OptionState.NEUTRAL);
        return b;
    }

    /** Also used as the initial style (NEUTRAL) and as the answer-feedback recolor (§4). Tints
     * the rounded drawable installed by optionButton()/OverlayTicTacToeHelper's cell creation --
     * does NOT call setBackgroundColor, which would replace that drawable with a flat fill. */
    public static void setOptionState(Button b, OptionState state) {
        int colorRes;
        switch (state) {
            case CORRECT:
                colorRes = R.color.overlay_option_correct;
                break;
            case INCORRECT:
                colorRes = R.color.overlay_option_incorrect;
                break;
            case NEUTRAL:
            default:
                colorRes = R.color.overlay_option_bg;
                break;
        }
        b.setTextColor(ContextCompat.getColor(b.getContext(), R.color.overlay_title));
        b.setBackgroundTintList(
                ColorStateList.valueOf(ContextCompat.getColor(b.getContext(), colorRes)));
    }

    /**
     * A horizontal row of dots, one per question, above the question text — more visually
     * prominent than the mission title. Quiz only; Tic-Tac-Toe has no equivalent (the board
     * is its own progress) and must not call this.
     */
    public static View buildProgressDots(Context context, int total, int currentIndex) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);

        int dotSize = context.getResources().getDimensionPixelSize(R.dimen.overlay_dot_size);
        int activeDotSize =
                context.getResources().getDimensionPixelSize(R.dimen.overlay_dot_active_size);
        int halfGap = context.getResources().getDimensionPixelSize(R.dimen.overlay_dot_gap) / 2;

        for (int i = 0; i < total; i++) {
            View dot = new View(context);
            boolean reached = i <= currentIndex;
            dot.setBackgroundResource(
                    reached ? R.drawable.overlay_dot_active : R.drawable.overlay_dot_inactive);
            int size = (i == currentIndex) ? activeDotSize : dotSize;
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(size, size);
            lp.setMargins(halfGap, 0, halfGap, 0);
            lp.gravity = Gravity.CENTER_VERTICAL;
            row.addView(dot, lp);
        }
        return row;
    }

    /**
     * Drops the raw {@code missionType} string (e.g. "quiz", "minigame") from the points
     * caption — a child doesn't need the schema's vocabulary. Decision: points-only, not a
     * type-to-word map — simpler, never drifts as mission types are added, and the mission
     * title already gives context.
     */
    public static String captionText(int points) {
        return points + " points";
    }

    public static int dp(Context context, int value) {
        float density = context.getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }

    private static void setTextSizePx(TextView tv, Context context, int dimenRes) {
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, context.getResources().getDimension(dimenRes));
    }
}
