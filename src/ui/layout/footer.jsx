// src/ui/layout/footer.jsx
import { FaInstagram, FaYoutube, FaTwitter, FaGithub } from 'react-icons/fa';
import styles from "@/styles/Global.module.css";
//import Navigation from "@/components/Navigation";

const Footer = () => {
  return (
    <footer className={`${styles.footer} gapSM`}>
      <div className={styles.credits}>
      <div className={styles.textsm}>
      <a href="https://t.me/thinkincoin" target="_blank" rel="noopener noreferrer" className={`${styles.textsm} hover:underline`}>
        Build by Think in Coin
      </a>
      </div>

      <div className={`${styles.socialIcons} `}>
        <a href="https://instagram.com/thinkincoin" target="_blank" rel="noopener noreferrer"><FaInstagram /></a>
        <a href="https://youtube.com/@thinkincoin" target="_blank" rel="noopener noreferrer"><FaYoutube /></a>
        <a href="https://twitter.com/thinkincoin" target="_blank" rel="noopener noreferrer"><FaTwitter /></a>
        <a href="https://github.com/thinkincoin" target="_blank" rel="noopener noreferrer"><FaGithub /></a>
      </div>
      </div>
    </footer>
  );
};

export default Footer;