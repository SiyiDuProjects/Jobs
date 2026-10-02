import { JobsControlFields } from "./control-fields.js";
export var JobsPlatformConfig;
let initialized = false;
export function initializePlatformConfig() {
  if (initialized) return;
  initialized = true;
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const workdayListbox =
      'button[aria-haspopup="listbox"],button[data-jobs-component="workday-listbox"]';
    const greenhouseGroup = '[id^="question_"][id$="[]"]';
    const workday = {
      vpsFailure: true,
      readOnlySummary: (node) =>
        !!node?.closest(
          '[data-automation-id="reviewJobApplicationPage"],[data-automation-id="applyFlowReviewPage"]',
        ),
      // Workday's optional blanks are not missing answers. The original profile
      // adapter may fill them, but they do not trigger supplemental AI.
      optionalSupplement: false,
      selectors:
        '[data-automation-id="dateInputWrapper"],fieldset[data-automation-id$="-CheckboxGroup"],button[data-jobs-component="workday-listbox"]',
      errorSelector:
        '[data-automation-id="inputError"],[data-automation-id="inputAlert"],[data-automation-id="errorBanner"]',
      // Workday's VPS page failures can replace the step or live beside it.
      // Read visible error-code text, not hidden previous steps or form values.
      failure(ctx) {
        const doc = ctx.doc;
        if (!doc.body) return null;
        const walker = doc.createTreeWalker(
          doc.body,
          doc.defaultView.NodeFilter.SHOW_TEXT,
        );
        let node;
        while ((node = walker.nextNode())) {
          const code = node.nodeValue.match(
            /\bVPS\|[a-f0-9]{8}-[a-f0-9-]{27,}/i,
          )?.[0];
          const element = node.parentElement;
          if (
            code &&
            element &&
            !element.closest("script,style,template,[data-jobs-diagnostics]") &&
            ctx.visible(element)
          )
            return { node: element, code };
        }
        return null;
      },
      // Newer Workday buttons combine the question, selected value and Required
      // in aria-label. Use the linked caption for answer matching.
      label(node, ctx) {
        if (!node.matches(workdayListbox)) return;
        const owner = node.closest('[data-automation-id^="formField-"]');
        const caption = [...(owner?.querySelectorAll("label") || [])].find(
          (label) => label.htmlFor === node.id,
        );
        if (caption) return ctx.textOnly(caption);
      },
      // The Workday fieldset is one question, including true multi-selects.
      // aria-required on every option requires an answer to the group, not
      // checking every box. Explicit single-choice wording uses radio semantics.
      choiceGroup(node, ctx) {
        if (!node.matches('fieldset[data-automation-id$="-CheckboxGroup"]'))
          return null;
        let owner = node,
          heading = "";
        while (owner && !heading) {
          heading = text(owner.querySelector(":scope > legend")?.textContent);
          owner = owner.parentElement?.closest("fieldset");
        }
        if (!heading) return null;
        const exclusive =
          /\b(?:check|select|choose) (?:only |exactly )?one\b/i.test(heading);
        const subject = node
          .getAttribute("data-automation-id")
          .replace(/-CheckboxGroup$/, "")
          .replace(/([a-z])([A-Z])/g, "$1 $2");
        const group = Array.from(
          node.querySelectorAll('input[type="checkbox"]'),
        ).filter(ctx.visible);
        return exclusive
          ? { exclusive: true, question: subject + " — " + heading, group }
          : { multiple: true, question: heading };
      },
      dateParts(node) {
        if (!node.matches('[data-automation-id="dateInputWrapper"]'))
          return null;
        const parts = ["Month", "Day", "Year"].map((part) => [
          ...node.querySelectorAll(
            `input[data-automation-id="dateSection${part}-input"]`,
          ),
        ]);
        return parts.every((part) => part.length === 1)
          ? parts.map((part) => part[0])
          : null;
      },
    };
    const icims = {
      // IForms puts each caption after the control wrapper, outside a label.
      // Stop at the row break/next control rather than collecting all choices.
      label(node, ctx) {
        if (
          !node.matches('input[type="radio"]') ||
          !node.parentElement?.matches(".iCIMS_Forms_RadioGroup") ||
          ctx.linkedText(node)
        )
          return;
        let caption = "";
        for (
          let sibling = node.parentElement.nextSibling;
          sibling;
          sibling = sibling.nextSibling
        ) {
          if (
            sibling.nodeType === 1 &&
            (sibling.matches("br,input,.customFieldContainer") ||
              sibling.querySelector("input"))
          )
            break;
          caption += sibling.textContent || "";
        }
        return text(caption) || undefined;
      },
      radioQuestion(node, label) {
        return node.name === "icims_f_Veteran" &&
          node.parentElement?.matches(".iCIMS_Forms_QVeteran")
          ? "Protected veteran status"
          : label;
      },
      cleanLabel: (label) => label.replace(/^Error\s*:\s*/i, ""),
      required: (node) =>
        node.getAttribute("i_required") === "true" ||
        node.classList.contains("iCIMS_Forms_RequiredField"),
      // iCIMS renders an anchor as the visible control, backed by a hidden native
      // select. Read the committed selection, not the search input.
      combobox(node) {
        if (!node.matches('a[id$="_icimsDropdown"]')) return null;
        const backing = node.ownerDocument.getElementById(
          node.id.replace(/_icimsDropdown$/, ""),
        );
        if (!backing?.matches('select[icimsdropdown-enabled="1"]')) return null;
        return {
          value:
            backing.value && !["-1", "-999"].includes(backing.value)
              ? text(backing.selectedOptions[0]?.textContent)
              : "",
          seen: [backing],
        };
      },
      errorSelector: ".iCIMS_ErrorMessage,.iCIMS_HasError",
      questionContext(row) {
        const node = row?.node;
        if (
          !node?.matches(
            '#icims_f_signature.iCIMS_Forms_Qsignature[type="checkbox"]',
          ) ||
          !node.form?.querySelector(
            '.iCIMS_Forms_QVeteran input[name="icims_f_Veteran"]',
          ) ||
          !/VOLUNTARY SELF-IDENTIFICATION OF VETERAN STATUS/i.test(
            node.form.textContent,
          )
        )
          return null;
        return {
          voluntaryVeteranSignature: true,
          signatureName: node.form.querySelector("#icims_f_Name")?.value || "",
        };
      },
    };
    const jazzhr = {
      // JazzHR uses a nonempty value for its unanswered placeholder. Share the
      // same interpretation with supplementation, review and readiness.
      placeholder: (option) => option.value === "resumator_no_selection",
    };
    const greenhouse = {
      // Legacy (boards) and current (job-boards) field error text.
      errorSelector: ".field-error-msg,.helper-text--error",
      choiceGroup(node) {
        if (
          !node.matches(greenhouseGroup) ||
          node.matches("input,select,textarea")
        )
          return null;
        const options = [...node.querySelectorAll('input[type="checkbox"]')];
        return options.length > 0 &&
          options.every(
            (option) =>
              option.name === node.id || option.id.startsWith(node.id + "_"),
          )
          ? // Native required is repeated on every option, but the page requires
            // an answer to this one question, not every checkbox to be selected.
            { multiple: true, requiredAsGroup: true }
          : null;
      },
      discover(scope) {
        return [
          ...(scope.matches?.(greenhouseGroup) ? [scope] : []),
          ...scope.querySelectorAll(greenhouseGroup),
        ].filter((node) => greenhouse.choiceGroup(node));
      },
      question(node, grouped, ctx) {
        if (!greenhouse.choiceGroup(node)) return;
        const doc = ctx.doc;
        const heading =
          doc.getElementById(node.id + "-label") ||
          [...doc.querySelectorAll("label[for]")].find(
            (label) => label.htmlFor === node.id,
          );
        if (heading) return ctx.textOnly(heading).slice(0, 700);
      },
      // Greenhouse renders a follow-up beside its preceding choice, often even
      // when that choice is No. Keep the full chain as the answer key.
      conditions(rows, ctx) {
        const ordered = [...rows].sort((a, b) =>
          a.node.compareDocumentPosition(b.node) &
          ctx.doc.defaultView.Node.DOCUMENT_POSITION_PRECEDING
            ? 1
            : -1,
        );
        const previous = new Map();
        for (const row of ordered) {
          const owner =
            row.node.closest("form,.application--questions") || ctx.root();
          const parent = previous.get(owner),
            prompt = row.public.question;
          previous.set(owner, row);
          if (!/^question_/.test(row.node.id)) continue;
          const match = prompt.match(/^if\s+(yes|no|other)\b\s*[,.:;-]?\s*/i);
          if (!match) continue;
          const choice =
            parent &&
            JobsControlFields.choiceTypes.includes(parent.public.type);
          const parentAnswer = choice ? ctx.response(parent)?.response : null;
          let active = null;
          if (parent?.public.conditional?.active === false) active = false;
          else if (
            choice &&
            parentAnswer &&
            parent.public.conditional?.active !== null
          ) {
            const selected =
              parent.public.type === "select-multiple"
                ? parentAnswer.split("; ")
                : [parentAnswer];
            const expected = match[1].toLowerCase();
            const labels = selected.map((value) => text(value).toLowerCase());
            // Only explicit Yes/No/Other choices establish these branches.
            active = labels.some(
              (label) =>
                label === expected ||
                (expected === "other" &&
                  /^other\s*\((?:please )?specify\)$/.test(label)),
            );
            if (
              expected !== "other" &&
              !labels.every((label) => /^(yes|no)$/.test(label))
            )
              active = null;
          }
          row.public.conditional = {
            prompt,
            active,
            parentId: choice ? parent.public.id : null,
            parentAnswer,
            parentQuestion: choice ? parent.public.question : null,
          };
          if (choice)
            row.public.question = parent.public.question + " — " + prompt;
          row.public.dependencyBlocked = active !== true;
        }
      },
      questionContext(row, item) {
        return row?.public.conditional ||
          !/^if\s+(?:yes|no|other)\b/i.test(item.question || "")
          ? null
          : {
              conditional: {
                prompt: item.question,
                active: null,
                parentId: null,
                parentAnswer: null,
                parentQuestion: null,
              },
            };
      },
    };
    const ashbyFieldset =
      "fieldset.ashby-application-form-input-checkbox-group";
    const ashbyEducation = ".ashby-application-form-input-education-entry";
    // Some Ashby labels target a wrapper (or a missing input id). Stop at
    // the nearest child caption so Education History never labels every child.
    const ashbyTitle = (node) => {
      const wrapped = node.closest(
        "label.ashby-application-form-question-title",
      );
      if (wrapped) return wrapped;
      for (let owner = node.parentElement; owner; owner = owner.parentElement) {
        if (owner.matches(ashbyEducation)) return null;
        const title = owner.querySelector(
          ":scope > .ashby-application-form-question-title",
        );
        if (title) return title;
        if (owner.matches("fieldset,.ashby-application-form-field-entry"))
          return null;
      }
      return null;
    };
    const ashby = {
      questionBox: ".ashby-application-form-field-entry",
      questionTitle: ".ashby-application-form-question-title",
      cleanLabel: (label) =>
        label.replace(/^Education History\s*—\s*(Still Student\?)$/i, "$1"),
      selectors: ashbyFieldset + ",.ashby-application-form-input-yesno",
      discover: (scope) => (scope.matches?.(ashbyFieldset) ? [scope] : []),
      choiceGroup: (node) =>
        node.matches(ashbyFieldset)
          ? { multiple: true }
          : node.matches(".ashby-application-form-input-yesno")
            ? { yesno: true }
            : null,
      question(node, grouped, ctx) {
        if (!node.closest(ashbyEducation)) return;
        const title = ashbyTitle(node);
        if (!title) return "";
        const label = ctx.textOnly(title);
        if (node.matches("select") && /^(Start|End) Date$/i.test(label)) {
          const part = text(node.options[0]?.textContent).match(
            /^(Month|Year)/i,
          )?.[1];
          return part ? `Education ${label.replace(/Date$/i, part)}` : label;
        }
        return label;
      },
      // Only the control's own title determines class-based required status.
      requiredTitle: ashbyTitle,
      // Ashby returns server validation in a separate summary without setting
      // aria-invalid on its still-populated text input. Other alerts are status.
      errorSummary(scope, ctx) {
        const nodes = [
          ...(scope?.querySelectorAll('[role="alert"]') || []),
        ].filter(
          (node) =>
            ctx.visible(node) &&
            /^Your form needs corrections\s*:?$/i.test(
              text(node.querySelector("h2")?.textContent),
            ),
        );
        return {
          nodes,
          titles: nodes.flatMap((node) =>
            [...node.querySelectorAll("li button")].map(
              (button) => button.textContent,
            ),
          ),
        };
      },
      questionContext(row) {
        const entry = row?.node.closest(ashbyEducation);
        const entries = entry
          ?.closest(".ashby-application-form-field-entry")
          ?.querySelectorAll(ashbyEducation);
        const educationIndex = entries ? [...entries].indexOf(entry) : -1;
        return {
          optionMatch: "exact-or-unique-boolean",
          ...(educationIndex >= 0 ? { educationIndex } : {}),
        };
      },
    };
    const breezy = {
      selectors: ".questionnaire-section .multiplechoice",
      // Honeypot inputs are not questions.
      skip: (node) =>
        /^candidate\.hp_/.test(node.getAttribute("ng-model") || "") ||
        (node.matches(".questionnaire-section .multiplechoice") &&
          !node.querySelector('input[type="checkbox"]')),
      label(node, ctx) {
        if (node.matches(".questionnaire-section .option input"))
          return ctx.textOnly(
            node.closest(".option")?.querySelector(":scope > span"),
          );
      },
      question(node, grouped, ctx) {
        const heading = node
          .closest(".questionnaire-section .question")
          ?.querySelector("h3");
        if (heading) return ctx.textOnly(heading).replace(/\s*\*\s*$/, "");
        if (node.matches('[name="cSummary"],[name="cCoverLetter"]'))
          return node.name === "cSummary"
            ? "Experience summary"
            : "Cover letter";
      },
      // A Yes/No pair rendered as checkboxes is one answer; a checked member
      // satisfies the group's own required validity.
      choiceGroup: (node) =>
        node.matches(".questionnaire-section .multiplechoice") &&
        node.querySelector('input[type="checkbox"]')
          ? { multiple: true, singleYesNo: true, requiredAsGroup: true }
          : null,
      errorSelector: ".error-container .error",
    };
    const lever = {
      // Lever places the question beside the field, while each radio's label
      // names only its option. The same structure is used by voluntary surveys.
      question(node, grouped, ctx) {
        const heading =
          node.closest(".application-field")?.previousElementSibling;
        if (heading?.matches(".application-label"))
          return (
            ctx.textOnly(heading.querySelector(".text") || heading) || undefined
          );
      },
      optionalSurvey: (node) =>
        !!node.closest('[id^="countrySurvey"],[id^="eeoSurvey"]'),
    };
    const tesla = {
      teslaCalendar: true,
      radioQuestion: (node, label) =>
        text(
          node
            .closest(".tds-form-item")
            ?.querySelector(":scope > label.tds-form-label")?.textContent,
        ) || label,
    };
    // All full-form roots and step navigation selectors live here. Adapters refer
    // to these declarations; field-specific bindings remain in their adapter.
    const structure = {
      adp: {
        confirmation: "#vdlContainerFluid .success-message-container",
        root: "#vdlContainerFluid",
        next: "#ja_sv_cw_next_footer_btn",
        submit: "#submitApplication",
      },
      ashby: {
        confirmation:
          "//h2[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'success')]",
        root: '[aria-labelledby="job-application-form"]',
        submit: "button.ashby-application-form-submit-button",
      },
      bamboohr: {
        confirmation:
          "//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'application has been submitted') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'application was submitted') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'thanks for applying') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'thank you for applying')]",
        root: "form",
        submitXPath: "//button[contains(., 'Submit Application')]",
      },
      breezy: {
        root: ".application-container",
        next: 'button[ng-click="nextSection()"]',
        submit: 'button[ng-click="apply()"]',
      },
      comeet: {
        confirmation:
          "//p[contains(text(),'Your application has been submitted')]",
        root: "form#applyForm",
        submitXPath: "//button[contains(text(),'Submit')]",
      },
      dayforce: {
        confirmation: "//div[@test-id='success-dayforce-jobs']",
        root: "form",
        next: "button[test-id='application-next-step']:not([disabled])",
        submit: "button[test-id='application-submit']:not([disabled])",
        reviewXPath: "//button[@test-id='application-submit']",
      },
      dover: {
        confirmation: "//div[contains(text(),'Thanks for applying!')]",
        rootXPath: "//div[contains(text(),'Apply')]/following-sibling::form",
        submit: "button[type='submit']",
      },
      eightfold: {
        confirmation:
          "#form-submission-success-message,[data-test-id='success-form']",
        rootXPath: "//div[@id='apply-form-main-content']",
        formXPath: "//div[contains(@class, 'applyFormContainer')]//form",
        submit: "button[data-test-id='position-apply-button']",
        formSubmit: "[data-test-id='submitApplicationButton']:not([disabled])",
      },
      freshteam: {
        confirmation: "#applicant-success:not(.hide)",
        rootXPath:
          "//div[@id='applicant-form' and contains(@style, 'display: block;')]",
        form: "form",
      },
      greenhouse: {
        confirmationUrl:
          /^(https:\/\/job-boards(?:\.eu)?\.greenhouse\.io\/[^/]+\/jobs\/\d+)\/confirmation\/?$/,
        root: "#application-form",
        olderForm: "#application_form",
        olderRoot: "#application",
        submit: ".application--submit button[type='submit']",
        olderSubmit: "#submit_app:not([disabled])",
        olderSubmitAny: "#submit_app",
      },
      gusto: {
        confirmation: "//li[3]//span[contains(text(), 'Thank you')]",
        root: "form#job-applicant-form",
        submit: "input[type='submit']:not([disabled])",
      },
      icims: {
        confirmation:
          "//div[contains(@class, 'iCIMS_SuccessMessage') and (contains(., 'application has been submitted') or contains(., 'application was submitted') or contains(., 'Thank you') or contains(., 'thank you'))]",
        root: "form",
        nextXPath: "//input[@type='submit' and contains(@class,'Primary')]",
        questionsNext: "#quesp_form_submit_i",
      },
      indeed: {
        root: "form",
        main: "main",
        nextXPath: "(//main//button[@type='button'])[last()]",
      },
      jazzhr: {
        submit: "#resumator-submit-resume",
        root: "#resumator-application-form, #resumator_form_wrapper",
      },
      jobvite: {
        confirmation: ".jv-page-applyconfirm",
        root: "form",
        consentRoot: "form[name='consentForm']",
        firstRootXPath:
          "//form[contains(@name, 'applyForm')]//div[contains(@ng-form,'step1')]",
        secondRootXPath:
          "//form[contains(@name, 'applyForm')]//div[contains(@ng-form,'step2')]",
        thirdRootXPath:
          "//form[contains(@name, 'applyForm')]//div[contains(@ng-form,'step3')]",
        next: "div[ng-if='showAcceptReject'] button:not([disabled]),button[aria-label='Next']:not([disabled])",
        submit: "button[aria-label='Send Application']:not([disabled])",
      },
      lever: {
        confirmation: "div.thanks",
        root: "#application-form",
        submit: "#btn-submit",
      },
      oracle: {
        root: "#main",
        ready: "#main .input-row",
        manualSubmitText: /^(?:submit|submit application)$/i,
      },
      paylocity: {
        confirmation: "#appSubmitResponseDiv",
        confirmationText:
          /\b(?:application (?:has been |was )?(?:successfully (?:submitted|received)|(?:submitted|received) successfully)|thank you for (?:applying|your application))\b/i,
        root: "form",
        infoRoot: "#pcty-wr-apply-info",
        eeoRoot: "#pcty-wr-eeopage",
        reviewRoot: "#pcty-wr-preview-jobapplication",
        next: "button[data-automation-id='btnNext']:not([disabled])",
        submit: "button[data-automation-id='btnSubmit']:not([disabled])",
      },
      phenom: {
        root: "form",
        next: "button.btn-next",
        submit: "button.btn-submit",
      },
      pinpoint: {
        confirmation:
          "//p[contains(text(), 'Your application was received successfully.')]",
        rootXPath: "//form[@id='application-form']",
      },
      polymer: {
        confirmation:
          "//h2[contains(text(),'Your application has been sent!')]",
        root: "#apply form",
        submit: "#apply form button[type='button']",
      },
      rippling: {
        root: "form#job-application-form",
        form: "form",
        submit: "form#job-application-form button[type='submit']",
        formSubmit: "form button[type='submit']:not([disabled])",
      },
      seek: {
        confirmation: "#applicationSent",
        root: "form",
        next: "[data-testid='continue-button']",
        submit: "button[data-testid='review-submit-application']",
      },
      smartrecruiters: {
        confirmation: "oc-success-page-content",
        root: "oc-oneclick-form",
        questionsRoot: "oc-screening-questions",
        next: "[data-test='footer-next']:not([disabled])",
        submit:
          "[data-test='footer-submit']:not([disabled]),oc-nav-screening-questions spl-button[type='primary']:not([disabled])",
      },
      successfactors: {
        confirmation: "#applyConfirmMsg",
        root: "form",
        submitXPath: "//span[@role='button' and contains(@id, 'submitBtn')]",
        saveXPath: "//span[@role='button' and contains(@id, 'saveBtn')]",
      },
      tesla: {
        confirmation: "//div[contains(@class, 'Confirmation_')]",
        root: "form",
        personalRoot: "#step--personal",
        jobRoot: "#step--job",
        legalRoot: "#step--legal",
        eeoRoot: "#step--eeo",
        next: "button[name='next']",
        submit: "button[type='submit']",
      },
      tiktok: {
        rootXPath:
          "//div[contains(@class, 'resumeFormPage')]//form[not(ancestor::form)]",
        submit: "button[data-test='applyResumeBtn']",
      },
      ultipro: {
        confirmation: "#ApplicationSubmitted",
        rootXPath: "//div[@id='OpportunityApply']",
        submitHost: '[data-automation="btn-submit"]',
        submitInner: "button",
      },
      workable: {
        confirmation: '[data-ui="successful-submit"]',
        rootXPath: "//form[@data-ui='application-form']",
        submit: "[data-ui='apply-button']:not([disabled])",
      },
      workday: {
        modernFlow: (doc) =>
          !!doc.querySelector('[data-automation-id="ApplyFlowPage"]'),
        root: '[data-automation-id="ApplyFlowPage"],[data-automation-id="applyFlowPage"]',
        reviewRoot:
          "[data-automation-id='reviewJobApplicationPage'],[data-automation-id='applyFlowReviewPage']",
        next: "button[data-automation-id='bottom-navigation-next-button'],button[data-automation-id='pageFooterNextButton']",
        nextEnabled:
          "button[data-automation-id='bottom-navigation-next-button']:not([disabled]),button[data-automation-id='pageFooterNextButton']:not([disabled])",
        resumeRootXPath:
          "//*[@data-automation-id='quickApplyPage' or @data-automation-id='applyFlowAutoFillPage']",
        infoRootXPath:
          "//*[@data-automation-id='contactInformationPage' or @data-automation-id='applyFlowMyInfoPage']",
        experienceRootXPath:
          "//*[@data-automation-id='myExperiencePage' or @data-automation-id='applyFlowMyExpPage']",
        firstQuestionsRootXPath:
          "//*[@data-automation-id='primaryQuestionnairePage' or @data-automation-id='applyFlowPrimaryQuestionsPage']",
        secondQuestionsRootXPath:
          "//*[@data-automation-id='secondaryQuestionnairePage' or @data-automation-id='applyFlowSecondaryQuestionsPage' or @data-automation-id='applyFlowSupplementaryQuestionsPage']",
        disclosuresRootXPath:
          "//*[@data-automation-id='voluntaryDisclosuresPage' or @data-automation-id='applyFlowVoluntaryDisclosuresPage']",
        identityRootXPath:
          "//*[@data-automation-id='selfIdentificationPage' or @data-automation-id='applyFlowSelfIdentifyPage']",
        reviewRootXPath:
          "//*[@data-automation-id='reviewJobApplicationPage' or @data-automation-id='applyFlowReviewPage']",
      },
    };
    for (const entry of Object.values(structure)) Object.freeze(entry);
    Object.freeze(structure);
    const entries = /** @type {Array<[string,RegExp,object]>} */ ([
      ["workday", /\.(myworkdayjobs|myworkdaysite)\.com$/, workday],
      ["icims", /(^|\.)icims\.com$/, icims],
      ["jazzhr", /(^|\.)(applytojob|theresumator)\.com$/, jazzhr],
      ["greenhouse", /(^|\.)greenhouse\.io$/, greenhouse],
      ["ashby", /^jobs\.ashbyhq\.com$/, ashby],
      [
        "smartrecruiters",
        /(^|\.)smartrecruiters\.com$/,
        {
          fieldScope: (node) =>
            node.closest("oc-experience-entry,oc-education-entry"),
          fieldRoots: (scope) =>
            [...scope.querySelectorAll("sr-screening-questions-form")]
              .map((node) => node.shadowRoot)
              .filter(Boolean),
        },
      ],
      ["breezy", /\.breezy\.hr$/, breezy],
      ["lever", /^jobs(?:\.[a-z]+)?\.lever\.co$/, lever],
      ["tesla", /(^|\.)tesla\.com$/, tesla],
    ]).map(([id, host, features]) =>
      Object.freeze({ id, host, features: Object.freeze({ id, ...features }) }),
    );
    const generic = Object.freeze({ id: "generic" });
    function detect(doc) {
      const hostname = doc?.location?.hostname || "";
      return (
        entries.find((entry) => entry.host.test(hostname))?.features || generic
      );
    }
    const fallbackRoots = 'form,[role="form"]';
    const rootKeys = {
      greenhouse: ["root", "olderForm", "olderRoot"],
      eightfold: ["rootXPath", "formXPath"],
      smartrecruiters: ["root", "questionsRoot"],
    };
    function visible(node) {
      if (
        !node?.isConnected ||
        node.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      const view = node.ownerDocument.defaultView;
      for (
        let current = node;
        current?.nodeType === 1;
        current = current.parentElement
      ) {
        const style = view.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    function find(doc, selector) {
      if (!selector) return [];
      if (!selector.startsWith("/") && !selector.startsWith("("))
        return [...doc.querySelectorAll(selector)];
      const result = doc.evaluate(
        selector,
        doc,
        null,
        doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return Array.from({ length: result.snapshotLength }, (_, i) =>
        result.snapshotItem(i),
      );
    }
    function confirmation(doc, platform) {
      const config = structure[platform];
      return (
        find(doc, config?.confirmation)
          .filter(visible)
          .find(
            (node) =>
              !config.confirmationText ||
              config.confirmationText.test(text(node.textContent)),
          ) || null
      );
    }
    function roots(doc, platform) {
      const config = structure[platform];
      const keys = rootKeys[platform] || ["root", "rootXPath"];
      for (const key of keys) {
        const matches = find(doc, config?.[key]).filter(visible);
        if (matches.length) return matches;
      }
      // A known form disappearing does not authorize a newsletter/login form.
      return config
        ? []
        : [...doc.querySelectorAll(fallbackRoots)].filter(visible);
    }
    // Mutation consumers can notice a newly inserted form without rescanning the
    // whole document for unrelated animation outside the existing form.
    function containsRoot(node, platform) {
      if (!node || node.nodeType !== 1) return false;
      const config = structure[platform];
      const selectors = (rootKeys[platform] || ["root", "rootXPath"])
        .map((key) => config?.[key])
        .filter(Boolean);
      return [...selectors, fallbackRoots].some((selector) => {
        if (!selector.startsWith("/") && !selector.startsWith("("))
          return node.matches(selector) || !!node.querySelector(selector);
        return find(node.ownerDocument, selector).some(
          (root) => node === root || node.contains(root),
        );
      });
    }
    function root(doc, platform, owned = null) {
      const matches = roots(doc, platform);
      if (
        owned &&
        visible(owned) &&
        matches.some((node) => node === owned || node.contains(owned))
      )
        return owned;
      return matches.length === 1 ? matches[0] : null;
    }
    // Re-read at use time: conditional steps replace buttons and change disabled
    // state. A page with two equally valid buttons is ambiguous, not first-match.
    function navigation(doc, platform, action) {
      const config = structure[platform];
      if (!config || !["next", "submit"].includes(action)) return null;
      let selectors =
        action === "next"
          ? [config.next, config.nextXPath, config.questionsNext]
          : [
              config.submit,
              config.submitXPath,
              config.olderSubmit,
              config.formSubmit,
            ];
      if (platform === "workday") {
        const review = find(doc, config.reviewRoot).some(visible);
        // Final submission is owned by the adapter's explicit review pipeline.
        // Merely observing the shared footer must not create submit authority.
        selectors = !review && action === "next" ? [config.next] : [];
      }
      let nodes = selectors.flatMap((selector) => find(doc, selector));
      if (platform === "ultipro" && action === "submit")
        nodes = find(doc, config.submitHost).flatMap((host) => [
          ...(host.shadowRoot?.querySelectorAll(config.submitInner) || []),
        ]);
      const owner = root(doc, platform);
      const candidates = [...new Set(nodes)].filter(
        (node) =>
          owner &&
          (owner.contains(node) || owner.contains(node.getRootNode()?.host)) &&
          visible(node) &&
          !node.disabled &&
          node.getAttribute("aria-disabled") !== "true",
      );
      return candidates.length === 1 ? candidates[0] : null;
    }
    JobsPlatformConfig = Object.freeze({
      detect,
      structure,
      root,
      roots,
      navigation,
      confirmation,
      containsRoot,
    });
  })();
}
