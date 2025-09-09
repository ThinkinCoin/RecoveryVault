import styles from "../../styles/Global.module.css";

export default function Alert({ type="info", title, message, tx }) {
  return (
    <div className={`${styles.alert} ${styles[type]}`}>
      {title && <strong>{title}</strong>}
      <div>{message}</div>
      {tx && <div className={styles.muted}>tx: {tx}</div>}
    </div>
  );
}
