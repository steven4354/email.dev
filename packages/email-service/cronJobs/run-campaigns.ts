import * as dotenv from "dotenv";
import { Client } from "pg";
import { createTransport } from "nodemailer";
import * as cron from "node-cron";
import * as cheerio from "cheerio";
import cronstrue from "cronstrue";

dotenv.config();

const connectionString = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ssl: {
    rejectUnauthorized: false,
  },
};

async function sendCampaignEmails() {
  const client = new Client(connectionString);
  await client.connect();

  // Acquire the lock
  const environment = process.env.ENVIRONMENT;

  if (!environment) {
    throw new Error("ENVIRONMENT not set");
  }
  const lock = await acquireLock(client, environment);

  const campaigns = await getCampaigns(client);
  for (const campaign of campaigns) {
    console.log("Starting campaign: ", campaign.campaign_id);

    try {
      const emailsToSend = campaign.daily_limit - campaign.emails_sent_today;
      if (emailsToSend <= 0) {
        console.log("Campaign limit reached moving to next campaign.");
        continue;
      }

      const recipients = await getRecipients(
        client,
        campaign.campaign_id,
        emailsToSend
      );

      // get sender email accounts
      const emailAccountsQuery = `
      SELECT 
      email_accounts.id,
      email_accounts.email_address AS from_email,
      email_accounts.display_name,
      email_accounts.smtp_host,
      email_accounts.smtp_port,
      email_accounts.username,
      email_accounts.password
      FROM campaign_email_accounts
      INNER JOIN email_accounts ON email_accounts.id = campaign_email_accounts.email_account_id
      WHERE campaign_email_accounts.campaign_id = $1
      `;
      const emailAccounts = await client.query(emailAccountsQuery, [
        campaign.campaign_id,
      ]);

      const getRandomDelay = (min: number, max: number) => {
        return Math.floor(Math.random() * (max - min + 1) + min);
      };

      // Do a maximum of 5 sends per campaign at a time
      // if the daily limit is greater than 5, just let the next cron job run do another 5, so on until its reached the limit
      for (let i = 0; i < 5; i++) {
        const recipient = recipients[i];

        // Check that recipient is a valid email address
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,7}$/;

        if (!emailRegex.test(recipient?.email_address)) {
          console.log("Invalid email address:", recipient?.email_address);
          continue;
        }

        const index = i % emailAccounts.rowCount;
        const emailAccount = emailAccounts.rows[index];

        console.log(
          "Campiagn id: ",
          campaign.campaign_id,
          " / ",
          "Sending email to: ",
          recipient.email_address,
          " / ",
          "From email: ",
          emailAccount.from_email
        );

        const transporter = createTransport(getTransporterConfig(emailAccount));

        const sentEmailResponse = await client.query("INSERT INTO sent_emails(recipient_id,campaign_id) VALUES ($1,$2) RETURNING id", [recipient.id, campaign.id])

        const sentEmailId = sentEmailResponse.rows[0].id

        const mailOptionsResponse = await getSendMailOptions(
          client,
          campaign,
          recipient,
          emailAccount,
          sentEmailId
        );


        if (!mailOptionsResponse) {
          console.log({ mailOptionsResponse })
          await client.query("DELETE FROM sent_emails WHERE id=$1", [sentEmailId])
          continue
        }

        const [sendMailOpts, { emailTemplateId, nextSendAtDate }] = mailOptionsResponse

        await transporter.sendMail(sendMailOpts);

        await client.query("UPDATE sent_emails SET email_template_id=$1, sent_at= now() WHERE id=$2", [emailTemplateId,sentEmailId])
        await client.query("UPDATE recipient_emails SET next_send_date=$1, sent_count=sent_count + 1 WHERE id=$2", [nextSendAtDate, recipient.id])

        await incrementEmailsSentToday(client, campaign.campaign_id);

        await updateRecipientEmails(
          client,
          recipient.email_address,
          campaign.campaign_id,
          emailAccount.id
        );

        const delay = getRandomDelay(30 * 1000, 2 * 60 * 1000); // 30s to 2min
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const unsentEmailsCount = await getUnsentEmailsCount(
        client,
        campaign.campaign_id
      );
      if (unsentEmailsCount === 0) {
        await updateCampaignStatus(client, campaign.campaign_id);
      }
    } catch (error) {
      console.error(
        `An error occurred during campaign ${campaign.campaign_id}:`,
        error
      );
      await pauseCampaignOnError(
        client,
        campaign.campaign_id,
        campaign.name,
        error
      );
    }
  }

  await releaseLock(client, lock.id);
  await client.end();
}

function getTransporterConfig(emailAccount: any) {
  return {
    host: emailAccount.smtp_host,
    port: emailAccount.smtp_port,
    secure: false,
    auth: {
      user: emailAccount.username,
      pass: emailAccount.password,
    },
  };
}

async function getSendMailOptions(
  client: Client,
  campaign: any,
  recipient: any,
  emailAccount: any,
  sentEmailId: string
) {


  // determine which email has to be sent and whether to send

  // count how many emails have already been sent to the user to determine which email to send next in the sequence
  const emailCount = await client.query("SELECT COUNT(*) FROM sent_emails WHERE recipient_id = $1", [recipient.id])
  let sentCount = emailCount.rows[0].count
  // subtract 1 from the sent count to get the actual sent count because before this function is called a temporary sent_email record is inserted into the database
  // to be able to generate the sentEmailId parameter
  sentCount = sentCount - 1

  const emailTemplateQuery = `
SELECT cs.days_delay, et.* FROM email_templates AS et 
JOIN campaign_sequence AS cs ON cs.email_template_id=et.id
WHERE cs.sequence_order=$1 AND cs.campaign_id=$2
  `
  const emailTemplateResponse = await client.query(emailTemplateQuery, [sentCount, campaign.campaign_id])
  if (emailTemplateResponse.rowCount === 0){
    // email template cant be found because the sequence order is greater than the number of email templates in the campaign
    // which means the sequence should have been complete for this recipient
    await client.query("UPDATE recipient_emails SET sent_count=$1 WHERE id=$2", [sentCount, recipient.id])

     return null
  }
  const emailTemplate = emailTemplateResponse.rows[0]

  // compare whether the days delay from the last send are the same as the current day
  //get the date of the last email sent
  if (sentCount > 0) {
    const expectedDate = new Date(recipient.next_send_date)
    console.log({ expectedDate: expectedDate.toLocaleString() })

    // return null if current date is less than expected date
    if (new Date() < expectedDate) return null
  }

  const sendMailOpts: any = {
    from: `${emailAccount.display_name} <${emailAccount.from_email}>`,
    to: recipient.email_address,
    subject: emailTemplate.subject,
    replyTo: campaign.reply_to_email_address,
  };

  const trackingPixelLink = `<img src="${process.env.TRACKING_SERVICE_URL}/newsletter-image/${sentEmailId}" />`;
  const $ = cheerio.load(emailTemplate.html_content);

  const links = $("a");
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const originalUrl = $(link).attr("href");

    const query = `INSERT INTO link_clicks (url, recipient_email_id, email_template_id) VALUES ($1, $2, $3) RETURNING id`;
    const result = await client.query(query, [originalUrl, recipient.id, emailTemplate.id]);
    const linkClickId = result.rows[0].id;

    $(link).attr(
      "href",
      `${process.env.TRACKING_SERVICE_URL}/link/${linkClickId}`
    );
  }

  if ($("body").length > 0) {
    $("body").append(trackingPixelLink);
    sendMailOpts["html"] = $.html();
  } else {
    sendMailOpts["html"] = $.html() + trackingPixelLink;
  }

  if (emailTemplate.text_content) {
    sendMailOpts["text"] = emailTemplate.text_content;
  }

  // determine the send at date for the next email
  let nextSendAtDate: any = new Date()
  const nextSequenceTemplate = await client.query(`
    SELECT days_delay FROM campaign_sequence WHERE sequence_order=$1 AND campaign_id=$2
      `, [parseInt(sentCount) + 1, campaign.campaign_id])

  if (nextSequenceTemplate.rowCount > 0) {
    nextSendAtDate.setDate(nextSendAtDate.getDate() + nextSequenceTemplate.rows[0].days_delay)
  }

  console.log({ sentCount, nextSendAtDate: nextSendAtDate.toLocaleString() })
  return [sendMailOpts, { emailTemplateId: emailTemplate.id, nextSendAtDate }];
}

type CampaignWithTemplate = {
  campaign_id: number;
  id: number;
  name: string;
  status: string;
  daily_limit: number;
  emails_sent_today: number;
  reply_to_email_address: string;
  email_template_id: number;
  archive: boolean;
  created_at: Date;
  updated_at: Date;
  subject: string;
  text_content: string;
  html_content: string;
};

async function getCampaigns(client: Client): Promise<CampaignWithTemplate[]> {
  const campaignsQuery = `
    SELECT  *,id AS campaign_id
    FROM campaigns
    WHERE campaigns.status = 'active' AND campaigns.archive = false
  `;
  const campaignsResult = await client.query(campaignsQuery);
  return campaignsResult.rows;
}

async function getRecipients(
  client: Client,
  campaignId: number,
  maxToSend: number
) {

  const recipientsQuery = `
    SELECT recipient_emails.id, recipient_emails.email_address, recipient_emails.next_send_date
    FROM recipient_emails
    JOIN campaigns ON recipient_emails.campaign_id = campaigns.id
    WHERE recipient_emails.campaign_id = $1 AND recipient_emails.sent_count < recipient_emails.total_to_send
    AND recipient_emails.next_send_date <= CURRENT_DATE
    LIMIT $2
  `;
  const recipientsResult = await client.query(recipientsQuery, [
    campaignId,
    maxToSend,
  ]);

  return recipientsResult.rows;
}

async function incrementEmailsSentToday(client: Client, campaignId: number) {
  const updateEmailsSentTodayQuery = `
    UPDATE campaigns
    SET emails_sent_today = emails_sent_today + 1
    WHERE id = $1
    RETURNING *
  `;
  const result = await client.query(updateEmailsSentTodayQuery, [campaignId]);

  if (result.rowCount === 0 || result.rows[0].emails_sent_today === null) {
    throw new Error(
      `Failed to increment emails_sent_today for campaign: ${campaignId}`
    );
  }
}

// TODO: update the email_address to be email_account_id
async function updateRecipientEmails(
  client: Client,
  email_address: string,
  campaign_id: number,
  sender_email_account_id: number
) {
  const updateRecipientEmailsQuery = `
    UPDATE recipient_emails
    SET sent = true, sent_at = NOW(), sender_email_account_id = $3
    WHERE email_address = $1 AND campaign_id = $2
    RETURNING sent, sent_at
  `;
  const result = await client.query(updateRecipientEmailsQuery, [
    email_address,
    campaign_id,
    sender_email_account_id
  ]);

  if (
    result.rowCount === 0 ||
    !result.rows[0].sent ||
    result.rows[0].sent_at === null
  ) {
    throw new Error(
      `Failed to update sent and sent_at for recipient: ${email_address}`
    );
  }
}

async function getUnsentEmailsCount(client: Client, campaignId: number) {
  const unsentEmailsQuery = `
    SELECT COUNT(*)
    FROM recipient_emails
    WHERE campaign_id = $1 AND sent = false
  `;
  const unsentEmailsResult = await client.query(unsentEmailsQuery, [
    campaignId,
  ]);
  return parseInt(unsentEmailsResult.rows[0].count);
}

async function updateCampaignStatus(client: Client, campaignId: number) {
  const updateCampaignStatusQuery = `
    UPDATE campaigns
    SET status = 'completed'
    WHERE id = $1
    RETURNING *
  `;
  const result = await client.query(updateCampaignStatusQuery, [campaignId]);

  if (
    result.rowCount === 0 ||
    !result.rows[0].status ||
    result.rows[0].status !== "completed"
  ) {
    throw new Error(
      `Failed to update status to 'completed' for campaign: ${campaignId}`
    );
  }
}

async function pauseCampaignOnError(
  client: Client,
  campaignId: number,
  campaignName: string,
  error: any
) {
  const updateCampaignQuery = `
    UPDATE campaigns
    SET status = 'paused', error = $1
    WHERE id = $2
  `;
  await client.query(updateCampaignQuery, [
    error.message,
    campaignId
  ]);
}

// Checks if a lock exists, if it does don't proceed
// But if its been locked for more than 30 minutes, delete the lock
async function acquireLock(client: Client, environment: string) {
  const checkLockQuery = `
    SELECT environment, locked_at FROM cron_lock
  `;
  const checkLockResult = await client.query(checkLockQuery);

  if (checkLockResult.rowCount > 0) {
    const lockedEnvironment = checkLockResult.rows[0].environment;
    const lockedAt = checkLockResult.rows[0].locked_at;
    const currentTime = new Date();
    const lockDuration = (currentTime.getTime() - lockedAt.getTime()) / 60000;

    if (lockDuration > 30) {
      const deleteLockQuery = `
        DELETE FROM cron_lock WHERE environment = $1
      `;
      await client.query(deleteLockQuery, [lockedEnvironment]);
    } else {
      throw new Error(
        `Lock already acquired by environment: ${lockedEnvironment}`
      );
    }
  }

  const lockQuery = `
    INSERT INTO cron_lock (environment, locked_at)
    VALUES ($1, NOW())
    RETURNING *
  `;
  const result = await client.query(lockQuery, [environment]);
  return result.rows[0];
}

async function releaseLock(client: Client, lockId: string) {
  const unlockQuery = `
    DELETE FROM cron_lock
    WHERE id = $1
  `;
  await client.query(unlockQuery, [lockId]);
}

const CRON_SCHEDULE =
  process.env.ENVIRONMENT === "prod" ? "*/15 * * * *" : "* * * * *";

cron.schedule(CRON_SCHEDULE, () => {
  const now = new Date();
  const pdtDateTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);

  const humanReadableCron = cronstrue.toString(CRON_SCHEDULE);
  console.log("\n\n\n\n");
  console.log(
    `${pdtDateTime}: Running email sender cron job ${humanReadableCron}`
  );

  if (!process.env.TRACKING_SERVICE_URL) {
    throw new Error(
      "TRACKING_SERVICE_URL environment variable must be set to run this cron"
    );
  }

  sendCampaignEmails()
    .then(() => {
      console.log("Finished sending emails for this " + humanReadableCron);
    })
    .catch((error) => {
      console.error("Error in email sender cron job:", error);
    });
});
